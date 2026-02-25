const nodeInterpreter = process.env.PM2_NODE_INTERPRETER || 'node';

module.exports = {
  apps: [
    {
      name: 'polymarket-trading-bot',
      script: 'src/index.js',
      interpreter: nodeInterpreter,
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      watch: false,
      out_file: 'data/logs/pm2-out.log',
      error_file: 'data/logs/pm2-error.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
