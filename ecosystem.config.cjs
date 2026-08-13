module.exports = {
  apps: [{
    name: 'newapi-monitor',
    cwd: '/root/newapi-monitor',
    script: './run-native.sh',
    interpreter: '/bin/sh',
    autorestart: true,
    max_memory_restart: '512M',
    time: true,
  }],
};
