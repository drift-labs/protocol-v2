import { ExportFileType } from './types';

const formatDate = (ts: number): string => {
	const d = new Date(ts * 1000);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
};

export const buildExportFileName = ({
	fileType,
	userPublicKeys,
	from,
	to,
	requestedAt,
	market,
	isEmpty,
}: {
	fileType: ExportFileType;
	userPublicKeys: string[];
	from: number;
	to: number;
	requestedAt: number;
	market?: string;
	isEmpty: boolean;
}): string => {
	const user = userPublicKeys[0];
	const parts = [fileType, user, formatDate(from), formatDate(to), formatDate(requestedAt)];
	if (market) {
		parts.push(market);
	}
	const base = parts.join('_');
	return `${base}${isEmpty ? '-' : ''}.csv.gz`;
};

export const buildExportS3Key = ({
	authority,
	fileName,
}: {
	authority: string;
	fileName: string;
}): string => `authority/${authority}/${fileName}`;
