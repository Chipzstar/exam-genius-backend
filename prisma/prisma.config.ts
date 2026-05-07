import { defineConfig, env } from 'prisma/config';

export default defineConfig({
	schema: './schema.prisma',
	datasource: {
		url: env('DIRECT_DATABASE_URL')
	}
});
