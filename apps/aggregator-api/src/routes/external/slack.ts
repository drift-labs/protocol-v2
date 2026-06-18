import crypto from 'crypto';
import { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';

type Json = Record<string, any>;

type VercelWebhookEvent = {
	id: string;
	type: string;
	createdAt?: number;
	region?: string;
	payload: Json;
};

type RequestWithRawBody = FastifyRequest & { rawBody?: string };

const VERCEL_API = 'https://api.vercel.com';

class VercelClient {
	private projects = new Map<string, string | undefined>();
	private envVars = new Map<string, string | undefined>();
	private members: Map<string, string> | undefined;

	constructor(
		private readonly token: string,
		private readonly teamId: string
	) {}

	private async fetchJson(path: string): Promise<Json | undefined> {
		const sep = path.includes('?') ? '&' : '?';
		const url = `${VERCEL_API}${path}${sep}teamId=${encodeURIComponent(this.teamId)}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.token}` },
		});
		if (!res.ok) {
			throw new Error(`Vercel API ${res.status} ${path}`);
		}
		return (await res.json()) as Json;
	}

	async getProjectName(
		projectId: string | undefined,
		log: FastifyBaseLogger
	): Promise<string | undefined> {
		if (!projectId) return undefined;
		if (this.projects.has(projectId)) return this.projects.get(projectId);
		try {
			const data = await this.fetchJson(`/v9/projects/${encodeURIComponent(projectId)}`);
			const name = typeof data?.name === 'string' ? data.name : undefined;
			this.projects.set(projectId, name);
			return name;
		} catch (err) {
			log.warn({ err, projectId }, 'Vercel project lookup failed');
			return undefined;
		}
	}

	async getEnvVarKey(
		projectId: string | undefined,
		envVarId: string | undefined,
		log: FastifyBaseLogger
	): Promise<string | undefined> {
		if (!projectId || !envVarId) return undefined;
		const cacheKey = `${projectId}/${envVarId}`;
		if (this.envVars.has(cacheKey)) return this.envVars.get(cacheKey);
		try {
			const data = await this.fetchJson(
				`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envVarId)}`
			);
			const key = typeof data?.key === 'string' ? data.key : undefined;
			this.envVars.set(cacheKey, key);
			return key;
		} catch (err) {
			log.warn({ err, projectId, envVarId }, 'Vercel env var lookup failed');
			return undefined;
		}
	}

	async getUsername(
		userId: string | undefined,
		log: FastifyBaseLogger
	): Promise<string | undefined> {
		if (!userId) return undefined;
		const members = await this.getMembers(log);
		return members?.get(userId);
	}

	private async getMembers(log: FastifyBaseLogger): Promise<Map<string, string> | undefined> {
		if (this.members) return this.members;
		try {
			const data = await this.fetchJson(
				`/v2/teams/${encodeURIComponent(this.teamId)}/members?limit=100`
			);
			const map = new Map<string, string>();
			for (const m of (data?.members ?? []) as Json[]) {
				const id = m.uid ?? m.userId ?? m.id;
				const label = m.username ?? m.name ?? m.email;
				if (id && label) map.set(id, label);
			}
			this.members = map;
			return map;
		} catch (err) {
			log.warn({ err }, 'Vercel team members lookup failed');
			return undefined;
		}
	}
}

let sharedClient: VercelClient | undefined;
const getVercelClient = (): VercelClient | undefined => {
	if (sharedClient) return sharedClient;
	const token = process.env.VERCEL_AUTH_TOKEN;
	const teamId = process.env.VERCEL_TEAM_ID;
	if (!token || !teamId) return undefined;
	sharedClient = new VercelClient(token, teamId);
	return sharedClient;
};

const verifySignature = (rawBody: string, secret: string, signature: string | undefined) => {
	if (!signature) return false;
	const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
	const sigBuf = Buffer.from(signature);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length) return false;
	return crypto.timingSafeEqual(sigBuf, expBuf);
};

type FormatContext = {
	event: VercelWebhookEvent;
	client: VercelClient | undefined;
	log: FastifyBaseLogger;
};

const projectRef = async (
	ctx: FormatContext,
	projectId: string | undefined,
	fallbackName?: string
): Promise<string | undefined> => {
	if (fallbackName) return projectId ? `${fallbackName} (${projectId})` : fallbackName;
	if (!projectId) return undefined;
	const name = await ctx.client?.getProjectName(projectId, ctx.log);
	return name ? `${name} (${projectId})` : projectId;
};

const userRef = async (
	ctx: FormatContext,
	userId: string | undefined
): Promise<string | undefined> => {
	if (!userId) return undefined;
	const username = await ctx.client?.getUsername(userId, ctx.log);
	return username ? `${username} (${userId})` : userId;
};

type FormattedEvent = {
	headline: string;
	fields: Array<[string, string | undefined]>;
};

const formatDeployment = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const d = payload.deployment ?? {};

	if (type === 'deployment.rollback') {
		return {
			headline: `Deployment rolled back — ${
				(await projectRef(ctx, payload.project?.id)) ?? 'unknown project'
			}`,
			fields: [
				['From', payload.fromDeploymentId],
				['To', payload.toDeploymentId],
				['By', await userRef(ctx, payload.user?.id)],
			],
		};
	}

	const action = type.split('.').slice(1).join(' ');
	const meta = d.meta ?? {};
	const branch = meta.githubCommitRef ?? meta.gitlabCommitRef ?? meta.bitbucketCommitRef;
	const sha = meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha;
	const commitAuthor =
		meta.githubCommitAuthorName ??
		meta.gitlabCommitAuthorName ??
		meta.bitbucketCommitAuthorName;

	return {
		headline: `Deployment ${action} — ${
			(await projectRef(ctx, payload.project?.id)) ?? 'unknown project'
		}`,
		fields: [
			['Target', d.target ?? payload.target],
			['Branch', branch],
			['Commit', sha ? String(sha).slice(0, 7) : undefined],
			['By', commitAuthor ?? (await userRef(ctx, payload.user?.id))],
			['URL', d.url ? `https://${d.url}` : undefined],
		],
	};
};

const formatProject = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').slice(1).join(' ');
	const headlineSuffix =
		type === 'project.renamed' && payload.previousName ? ` (was ${payload.previousName})` : '';
	return {
		headline: `Project ${action} — ${
			(await projectRef(ctx, payload.project?.id, payload.project?.name)) ?? 'unknown project'
		}${headlineSuffix}`,
		fields: [['By', await userRef(ctx, payload.user?.id)]],
	};
};

const formatEnvVariable = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').pop();
	const projectId = payload.projectId ?? payload.project?.id;
	const envVarKey = await ctx.client?.getEnvVarKey(projectId, payload.envVarId, ctx.log);
	const envVarRef = envVarKey ? `${envVarKey} (${payload.envVarId})` : payload.envVarId;

	return {
		headline: `Env variable ${action} — ${
			(await projectRef(ctx, projectId)) ?? 'unknown project'
		}`,
		fields: [
			['Variable', envVarRef],
			['By', await userRef(ctx, payload.user?.id)],
		],
	};
};

const formatRollingRelease = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').pop();
	const rr = payload.rollingRelease ?? {};
	return {
		headline: `Rolling release ${action} — ${
			(await projectRef(ctx, payload.project?.id, payload.project?.name)) ?? 'unknown project'
		}`,
		fields: [
			['State', rr.state],
			['Target %', rr.default?.targetPercentage],
			['Target deployment', rr.default?.targetDeploymentId],
			['By', rr.writtenBy ?? (await userRef(ctx, payload.user?.id))],
		],
	};
};

const formatProjectDomain = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').slice(2).join(' ');

	if (type === 'project.domain.updated') {
		return {
			headline: `Project domain updated — ${
				(await projectRef(ctx, payload.project?.id)) ?? 'unknown project'
			}`,
			fields: [
				['Previous', payload.previous?.domain],
				['Next', payload.next?.domain],
				['By', await userRef(ctx, payload.user?.id)],
			],
		};
	}

	if (type === 'project.domain.moved') {
		return {
			headline: `Project domain moved — ${payload.domain?.name ?? 'unknown domain'}`,
			fields: [
				['From project', await projectRef(ctx, payload.from?.projectId)],
				['To project', await projectRef(ctx, payload.to?.projectId)],
				['By', await userRef(ctx, payload.user?.id)],
			],
		};
	}

	return {
		headline: `Project domain ${action} — ${
			(await projectRef(ctx, payload.project?.id)) ?? 'unknown project'
		}`,
		fields: [
			['Domain', payload.domain?.name],
			['Target', payload.domain?.classification?.target],
			['By', await userRef(ctx, payload.user?.id)],
		],
	};
};

const formatDomain = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').slice(1).join(' ');
	const domain = payload.domain?.name ?? payload.zone;

	const fields: Array<[string, string | undefined]> = [];

	if (type.includes('dns-records') || type.includes('dns.records')) {
		fields.push(['Zone', payload.zone]);
		const changes = payload.changes ?? payload.records ?? payload.dnsRecords;
		if (Array.isArray(changes)) fields.push(['Changes', `${changes.length} record(s)`]);
	} else if (type.includes('auto-renew')) {
		fields.push(['From', String(payload.previous)]);
		fields.push(['To', String(payload.next)]);
	} else if (type.includes('certificate')) {
		const cert = payload.cert ?? {};
		if (cert.cn) fields.push(['Common name', cert.cn]);
		if (Array.isArray(payload.dnsNames) && payload.dnsNames.length)
			fields.push(['DNS names', payload.dnsNames.join(', ')]);
	} else if (type.includes('renewal')) {
		fields.push(['Expires', payload.expirationDate]);
		fields.push(['Reason', payload.errorReason ?? payload.reason]);
	} else if (type.includes('transfer-in')) {
		fields.push(['Reason', payload.reason]);
	}

	fields.push(['By', await userRef(ctx, payload.user?.id)]);

	return {
		headline: `Domain ${action} — ${domain ?? 'unknown'}`,
		fields,
	};
};

const formatFlag = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const action = type.split('.').slice(1).join(' ');
	const flag = payload.flag ?? {};
	const flagRef = flag.slug ? `${flag.slug} (${flag.id ?? '—'})` : flag.id;

	if (type.startsWith('flag.segment')) {
		const seg = payload.segment ?? {};
		const segRef = seg.slug ?? seg.key ?? seg.id;
		return {
			headline: `Flag segment ${action.replace('segment ', '')} — ${segRef ?? 'unknown'}`,
			fields: [
				['Flag', flagRef],
				['Project', await projectRef(ctx, flag.projectId)],
				['By', await userRef(ctx, payload.user?.id)],
			],
		};
	}

	return {
		headline: `Flag ${action} — ${flagRef ?? 'unknown'}`,
		fields: [
			['Project', await projectRef(ctx, flag.projectId)],
			['Previous slug', payload.previousFlag?.slug],
			['By', await userRef(ctx, payload.user?.id)],
		],
	};
};

const formatAlerts = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { payload } = ctx.event;
	const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
	const titles = alerts
		.map((a: Json) => a.title)
		.filter(Boolean)
		.slice(0, 3)
		.join(', ');

	return {
		headline: `Alert triggered — ${
			(await projectRef(ctx, payload.projectId, payload.projectSlug)) ?? 'unknown project'
		}`,
		fields: [
			['Alerts', titles ? `${alerts.length}: ${titles}` : `${alerts.length}`],
			['Observability', payload.links?.observability],
		],
	};
};

const formatFirewall = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	const attack = payload.attack ?? payload;
	const action = type.split('.').slice(1).join(' ');

	return {
		headline: `Firewall ${action} — ${
			(await projectRef(ctx, payload.projectId ?? payload.project?.id)) ?? 'unknown project'
		}`,
		fields: [
			['Attack type', attack.type ?? attack.kind],
			['Source IP', attack.ip ?? attack.sourceIp],
			['Host', attack.host],
			['Path', attack.path],
			['Action', attack.action],
		],
	};
};

const formatGeneric = async (ctx: FormatContext): Promise<FormattedEvent> => {
	const { type, payload } = ctx.event;
	return {
		headline: `Vercel — ${type}`,
		fields: [
			['Project', await projectRef(ctx, payload.project?.id ?? payload.projectId)],
			['By', await userRef(ctx, payload.user?.id)],
		],
	};
};

type Formatter = (ctx: FormatContext) => Promise<FormattedEvent>;

const dispatch = (type: string): Formatter => {
	if (type.startsWith('deployment.')) return formatDeployment;
	if (type.startsWith('project.domain.')) return formatProjectDomain;
	if (type.startsWith('project.rolling-release.')) return formatRollingRelease;
	if (type.startsWith('project.env-variable.')) return formatEnvVariable;
	if (type.startsWith('project.')) return formatProject;
	if (type.startsWith('domain.')) return formatDomain;
	if (type.startsWith('flag.')) return formatFlag;
	if (type === 'alerts.triggered') return formatAlerts;
	if (type.startsWith('firewall.')) return formatFirewall;
	return formatGeneric;
};

const buildSlackMessage = (event: VercelWebhookEvent, formatted: FormattedEvent) => {
	const lines: string[] = [`*${formatted.headline}*`];
	for (const [label, value] of formatted.fields) {
		if (value === undefined || value === null || value === '') continue;
		lines.push(`*${label}:* ${value}`);
	}
	if (event.createdAt) lines.push(`*At:* ${new Date(event.createdAt).toISOString()}`);

	const link =
		event.payload.links?.deployment ??
		event.payload.links?.project ??
		event.payload.links?.observability;
	if (link) lines.push(`*Link:* ${link}`);

	return {
		text: formatted.headline,
		blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
	};
};

const slackRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addContentTypeParser(
		'application/json',
		{ parseAs: 'string' },
		(req, body: string, done) => {
			(req as RequestWithRawBody).rawBody = body;
			try {
				const json = body.length ? JSON.parse(body) : {};
				done(null, json);
			} catch (err) {
				done(err as Error, undefined);
			}
		}
	);

	fastify.post(
		'/slack/vercel',
		{
			schema: {
				hide: true,
				description: 'Incoming Vercel webhook that forwards events to Slack.',
			},
		},
		async function (request, reply) {
			const secret = process.env.VERCEL_WEBHOOK_SECRET;
			const slackUrl = process.env.VERCEL_SLACK_WEBHOOK_URL;
			if (!secret || !slackUrl) {
				request.log.error('Missing VERCEL_WEBHOOK_SECRET or VERCEL_SLACK_WEBHOOK_URL');
				return reply.code(500).send({ error: 'Server misconfiguration' });
			}

			const rawBody = (request as RequestWithRawBody).rawBody ?? '';
			const signatureHeader = request.headers['x-vercel-signature'];
			const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

			if (!verifySignature(rawBody, secret, signature)) {
				return reply.code(401).send({ error: 'Invalid signature' });
			}

			const event = request.body as VercelWebhookEvent;
			const client = getVercelClient();

			let formatted: FormattedEvent;
			try {
				formatted = await dispatch(event.type)({ event, client, log: request.log });
			} catch (err) {
				request.log.error({ err, type: event.type }, 'Vercel event formatting failed');
				formatted = {
					headline: `Vercel — ${event.type}`,
					fields: [['Event ID', event.id]],
				};
			}

			const message = buildSlackMessage(event, formatted);

			try {
				const response = await fetch(slackUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(message),
				});
				if (!response.ok) {
					const text = await response.text();
					request.log.error(
						{ status: response.status, body: text },
						'Slack webhook failed'
					);
					return reply.code(502).send({ error: 'Failed to post to Slack' });
				}
			} catch (err) {
				request.log.error({ err }, 'Slack webhook request error');
				return reply.code(502).send({ error: 'Failed to post to Slack' });
			}

			return reply.send({ ok: true });
		}
	);
};

export default slackRoutes;
