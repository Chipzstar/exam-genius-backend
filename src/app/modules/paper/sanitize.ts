/** Match dashboard sanitize: URL-safe unit slug handling */
export function sanitize(s: string): string {
	return s.replace(/[^a-zA-Z0-9-_]/g, '-');
}
