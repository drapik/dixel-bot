# PowerShell Deployment Script for Windows
$ErrorActionPreference = "Stop"

# Configuration
$REMOTE_HOST = "192.168.1.95"
$REMOTE_USER = "root"
$REMOTE_PATH = "/opt/dixel-mini-app"

Write-Host "🚀 Starting deployment to $REMOTE_HOST..." -ForegroundColor Green

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "❌ Error: .env file not found!" -ForegroundColor Red
    Write-Host "Please create .env file based on .env.example" -ForegroundColor Yellow
    exit 1
}

# Check if ssh is available
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $sshCmd) {
    Write-Host "❌ Error: ssh command not found!" -ForegroundColor Red
    Write-Host "Please install OpenSSH client or use Git Bash" -ForegroundColor Yellow
    exit 1
}

# Create remote directory
Write-Host "📁 Creating remote directory..." -ForegroundColor Cyan
ssh ${REMOTE_USER}@${REMOTE_HOST} "mkdir -p ${REMOTE_PATH}"

# Copy files using scp (more compatible than rsync on Windows)
Write-Host "📤 Copying files to remote server..." -ForegroundColor Cyan

$filesToCopy = @(
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    ".env",
    "package.json",
    "package-lock.json",
    "index.html"
)

foreach ($file in $filesToCopy) {
    if (Test-Path $file) {
        scp $file "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
    }
}

# Copy server directory
if (Test-Path "server") {
    scp -r server "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
}

# Copy scripts directory (used by docker-compose importer)
if (Test-Path "scripts") {
    scp -r scripts "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
}

# Deploy on remote server
Write-Host "🐳 Building and starting Docker containers..." -ForegroundColor Cyan

$deployScript = @'
cd /opt/dixel-mini-app
docker compose down 2>/dev/null || true
docker compose up -d --build
echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Container status:"
docker compose ps
echo ""
echo "📝 Logs (last 20 lines):"
docker compose logs --tail=20
echo ""
echo "🌐 Application available at: https://opt-zakaz.dixel.store"
'@

ssh ${REMOTE_USER}@${REMOTE_HOST} $deployScript

Write-Host ""
Write-Host "✨ Deployment finished successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  View logs: ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose logs -f'"
Write-Host "  Restart:   ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose restart'"
Write-Host "  Stop:      ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose down'"
