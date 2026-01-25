#!/bin/bash

set -e

# Configuration
REMOTE_HOST="192.168.1.95"
REMOTE_USER="root"
REMOTE_PATH="/opt/dixel-mini-app"
PROJECT_NAME="dixel-mini-app"

echo "🚀 Starting deployment to $REMOTE_HOST..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create .env file based on .env.example"
    exit 1
fi

# Create remote directory
echo "📁 Creating remote directory..."
ssh ${REMOTE_USER}@${REMOTE_HOST} "mkdir -p ${REMOTE_PATH}"

# Copy files to remote server
echo "📤 Copying files to remote server..."
rsync -avz --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dixel_complete.yml' \
    --exclude='scripts' \
    --exclude='README.md' \
    ./ ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/

# Deploy on remote server
echo "🐳 Building and starting Docker containers..."
ssh ${REMOTE_USER}@${REMOTE_HOST} << 'ENDSSH'
cd /opt/dixel-mini-app

# Stop and remove old containers
docker compose down 2>/dev/null || true

# Build and start new containers
docker compose up -d --build

# Show status
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
ENDSSH

echo ""
echo "✨ Deployment finished successfully!"
echo ""
echo "Useful commands:"
echo "  View logs: ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose logs -f'"
echo "  Restart:   ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose restart'"
echo "  Stop:      ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_PATH} && docker compose down'"
