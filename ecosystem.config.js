/**
 * PM2 config for production.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save                            # persist across reboots
 *   pm2 startup                         # print the systemd command to enable auto-start
 *
 * Restart / inspect:
 *   pm2 restart theatre
 *   pm2 logs theatre
 *   pm2 status
 */
module.exports = {
    apps: [
        {
            name: 'theatre',
            script: 'server.js',
            cwd: __dirname,
            instances: 1,                  // SQLite + WAL = single writer, don't cluster
            exec_mode: 'fork',
            max_memory_restart: '400M',
            watch: false,                  // never in prod — the app writes its own DB next to itself
            autorestart: true,
            kill_timeout: 10_000,          // give the app time to drain (matches shutdown() in server.js)

            env: {
                NODE_ENV: 'development',
            },
            env_production: {
                NODE_ENV: 'production',
                // The rest (PORT, GMAIL_*, ADMIN_*, etc.) comes from .env via dotenv.
            },

            out_file:    './logs/out.log',
            error_file:  './logs/err.log',
            merge_logs:  true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
