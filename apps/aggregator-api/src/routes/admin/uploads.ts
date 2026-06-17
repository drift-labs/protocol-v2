import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FastifyPluginAsync } from 'fastify';

const DRIFT_PUBLIC_BUCKET = 'drift-public';
const DRIFT_PUBLIC_REGION = 'eu-central-1';
const PRESIGN_EXPIRY_SECONDS = 5 * 60;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/svg+xml',
] as const;

type UploadPrefix = 'protocols' | 'markets';

const PREFIX_PATHS: Record<UploadPrefix, string> = {
	protocols: 'protocols',
	markets: 'assets/icons/markets',
};

const SLUG_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const presignBodySchema = {
	type: 'object',
	required: ['prefix', 'slug', 'extension', 'contentType', 'contentLength'],
	properties: {
		prefix: { type: 'string', enum: ['protocols', 'markets'] },
		// `slug` is the file's identifier without extension — e.g. the vault
		// manager pubkey for `protocols/`, the market symbol for `markets/`.
		slug: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,64}$' },
		extension: { type: 'string', enum: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] },
		contentType: { type: 'string', enum: ALLOWED_CONTENT_TYPES as unknown as string[] },
		contentLength: { type: 'integer', minimum: 1, maximum: MAX_UPLOAD_BYTES },
	},
	additionalProperties: false,
} as const;

const uploadsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const s3 = new S3Client({ region: DRIFT_PUBLIC_REGION });

	fastify.post<{
		Body: {
			prefix: UploadPrefix;
			slug: string;
			extension: string;
			contentType: (typeof ALLOWED_CONTENT_TYPES)[number];
			contentLength: number;
		};
	}>(
		'/presign',
		{
			schema: {
				hide: true,
				description:
					'Presign a PUT to drift-public for a vault-manager image (protocols/) or market icon (assets/icons/markets/). Dashboard uploads directly to S3 using the returned URL.',
				tags: ['Admin'],
				body: presignBodySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							upload: {
								type: 'object',
								required: ['uploadUrl', 'publicUrl', 'expiresIn', 'key'],
								properties: {
									uploadUrl: { type: 'string' },
									publicUrl: { type: 'string' },
									expiresIn: { type: 'integer' },
									key: { type: 'string' },
								},
							},
						},
					},
				},
			},
		},
		async (request, reply) => {
			const { prefix, slug, extension, contentType, contentLength } = request.body;

			if (!SLUG_RE.test(slug)) {
				return reply.code(400).send({ success: false, error: 'Invalid slug' });
			}

			const key = `${PREFIX_PATHS[prefix]}/${slug}.${extension}`;

			const command = new PutObjectCommand({
				Bucket: DRIFT_PUBLIC_BUCKET,
				Key: key,
				ContentType: contentType,
				ContentLength: contentLength,
			});

			const uploadUrl = await getSignedUrl(s3, command, {
				expiresIn: PRESIGN_EXPIRY_SECONDS,
			});
			const publicUrl = `https://${DRIFT_PUBLIC_BUCKET}.s3.${DRIFT_PUBLIC_REGION}.amazonaws.com/${key}`;

			return reply.send({
				success: true,
				upload: {
					uploadUrl,
					publicUrl,
					expiresIn: PRESIGN_EXPIRY_SECONDS,
					key,
				},
			});
		}
	);
};

export default uploadsRoutes;
