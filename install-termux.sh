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
python -m pip install --no-deps fastapi uvicorn httpx pydantic 2>/dev/null || python -m pip install fastapi uvicorn httpx pydantic

# Install Node deps & build frontend
echo "Building frontend..."
cd frontend
npm install
npm run build
cd ..

# Create start script
cat > start.sh << 'STARTEOF'
#!/data/data/com.termux/files/usr/bin/bash
# AI Proxy launcher.
# The master key falls back to the built-in default so the console is usable
# immediately; export PROXY_MASTER_KEY to override, or HOST=0.0.0.0 to expose
# the proxy on the LAN (do that only with your own master key set).
cd "$(cd "$(dirname "$0")" && pwd)/backend"
PROXY_MASTER_KEY="${PROXY_MASTER_KEY:-sk-proxy-default-master-key}" \
  python -m uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
STARTEOF
chmod +x start.sh

echo -e "${GREEN}=== Done! ===${NC}"
echo "Run: ./start.sh"
echo "Dashboard: http://localhost:8000/app/"
echo "Master key: sk-proxy-default-master-key  (set PROXY_MASTER_KEY to change)"
