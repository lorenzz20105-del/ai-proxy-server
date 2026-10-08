#!/data/data/com.termux/files/usr/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}=== AI Proxy - Termux Installer ===${NC}"

# Check architecture
ARCH=$(uname -m)
echo "Architecture: $ARCH"

# Update packages
echo "Updating packages..."
pkg update -y -q && pkg upgrade -y -q

# Install Python, Node.js, git
echo "Installing Python, Node.js, git..."
pkg install -y python nodejs git

# Install Python deps
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install fastapi uvicorn httpx pydantic

# Install Node deps & build frontend
echo "Building frontend..."
cd frontend
npm install
npm run build
cd ..

# Create start script
cat > start.sh << 'STARTEOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")/backend"
PROXY_MASTER_KEY="${PROXY_MASTER_KEY:-$(openssl rand -hex 16)}" \
  python -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
STARTEOF
chmod +x start.sh

echo -e "${GREEN}=== Done! ===${NC}"
echo "Run: ./start.sh"
echo "Dashboard: http://localhost:8000/app/"
