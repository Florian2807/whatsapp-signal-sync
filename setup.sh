#!/bin/bash

# WhatsApp-Signal-Bridge Setup Script
# Automates the initial setup of the bridge service

set -e

echo "🚀 WhatsApp-Signal-Bridge Setup"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Global variables
BRIDGE_PORT=3000
SIGNAL_API_PORT=8080
CONTAINER_NAME=signal-api
USE_SUDO=""
CHROME_PATH=""

# ============================================================================
# Logging Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# ============================================================================
# Helper Functions
# ============================================================================

# Read port configuration from .env file
read_env_ports() {
    if [ -f .env ]; then
        if grep -q "^PORT=" .env; then
            BRIDGE_PORT=$(grep "^PORT=" .env | cut -d'=' -f2)
        fi
        if grep -q "^SIGNAL_API_PORT=" .env; then
            SIGNAL_API_PORT=$(grep "^SIGNAL_API_PORT=" .env | cut -d'=' -f2)
        fi
    fi
}

# Wait for Signal API to become ready
wait_for_signal_api() {
    log_info "Waiting for Signal API on port ${SIGNAL_API_PORT}..."
    local max_attempts=30
    local attempt=0
    
    until curl -s "http://localhost:${SIGNAL_API_PORT}/v1/about" >/dev/null 2>&1; do
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
        if [ $attempt -ge $max_attempts ]; then
            echo
            log_error "Signal API did not start within expected time"
            return 1
        fi
    done
    echo
    log_success "Signal API is ready"
}

# Check if Signal accounts exist
get_signal_accounts() {
    curl -s "http://localhost:${SIGNAL_API_PORT}/v1/accounts" 2>/dev/null || echo "[]"
}

# Open QR code in browser
open_in_browser() {
    local url="$1"
    if command -v "$BROWSER" &> /dev/null; then
        "$BROWSER" "$url" &>/dev/null &
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$url" &>/dev/null &
    elif command -v open &> /dev/null; then
        open "$url" &>/dev/null &
    else
        echo "Please open manually: $url"
    fi
}

# Detect Chrome/Chromium executable path
detect_chrome_path() {
    local chrome_paths=(
        "/usr/bin/google-chrome"
        "/usr/bin/google-chrome-stable"
        "/usr/bin/chromium"
        "/usr/bin/chromium-browser"
        "/snap/bin/chromium"
        "/usr/bin/chrome"
        "/opt/google/chrome/chrome"
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "$HOME/.local/bin/chrome"
    )
    
    # Check common paths
    for path in "${chrome_paths[@]}"; do
        if [ -x "$path" ]; then
            echo "$path"
            return 0
        fi
    done
    
    # Try to find via command
    if command -v google-chrome &> /dev/null; then
        which google-chrome
        return 0
    elif command -v google-chrome-stable &> /dev/null; then
        which google-chrome-stable
        return 0
    elif command -v chromium &> /dev/null; then
        which chromium
        return 0
    elif command -v chromium-browser &> /dev/null; then
        which chromium-browser
        return 0
    fi
    
    return 1
}

# ============================================================================
# Setup Functions
# ============================================================================


check_requirements() {
    log_info "Checking prerequisites..."
    
    # Check required commands
    local missing=()
    command -v docker &> /dev/null || missing+=("Docker")
    command -v node &> /dev/null || missing+=("Node.js")
    command -v npm &> /dev/null || missing+=("npm")
    
    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required tools: ${missing[*]}"
        log_info "Please install the missing tools and try again."
        exit 1
    fi
    
    # Check for Chrome/Chromium (required for WhatsApp Web)
    log_info "Checking for Chrome/Chromium..."
    set +e  # Temporarily disable exit on error
    CHROME_PATH=$(detect_chrome_path)
    local chrome_status=$?
    set -e  # Re-enable exit on error
    
    if [ $chrome_status -ne 0 ] || [ -z "$CHROME_PATH" ]; then
        log_error "Chrome or Chromium not found!"
        echo
        echo "WhatsApp Web requires Chrome/Chromium to function."
        echo
        echo "Installation options:"
        echo "  • Ubuntu/Debian: sudo apt install chromium-browser"
        echo "  • Fedora/RHEL:   sudo dnf install chromium"
        echo "  • Arch Linux:    sudo pacman -S chromium"
        echo "  • macOS:         brew install --cask google-chrome"
        echo
        exit 1
    fi
    log_success "Chrome found: $CHROME_PATH"
    
    # Check Docker permissions
    if docker info &> /dev/null 2>&1; then
        log_success "Docker access confirmed"
        USE_SUDO=""
    else
        log_warning "Docker requires elevated permissions"
        echo
        echo "Options:"
        echo "1) Use sudo for Docker commands (recommended)"
        echo "2) Continue without sudo (may fail)"
        echo
        read -p "Choose option (1-2): " choice
        
        case $choice in
            1)
                if sudo docker info &> /dev/null 2>&1; then
                    USE_SUDO="sudo"
                    log_success "sudo access confirmed"
                else
                    log_error "sudo access failed. Please check your permissions."
                    exit 1
                fi
                ;;
            2)
                log_warning "Continuing without sudo..."
                USE_SUDO=""
                ;;
            *)
                log_error "Invalid option"
                exit 1
                ;;
        esac
    fi
    
    log_success "All prerequisites met"
}


setup_env() {
    log_info "Configuring environment variables..."
    
    if [ -f .env ]; then
        log_warning ".env file already exists, using existing configuration"
        read_env_ports
        log_info "Ports: Bridge=${BRIDGE_PORT}, Signal API=${SIGNAL_API_PORT}"
        
        # Update chrome_path if not set or incorrect
        if ! grep -q "^chrome_path=" .env || ! [ -x "$(grep "^chrome_path=" .env | cut -d'=' -f2-)" ]; then
            log_info "Updating chrome_path in existing .env..."
            if grep -q "^chrome_path=" .env; then
                sed -i "s|chrome_path=.*|chrome_path=${CHROME_PATH}|" .env
            else
                echo "chrome_path=${CHROME_PATH}" >> .env
            fi
            log_success "Chrome path updated: ${CHROME_PATH}"
        fi
        return
    fi
    
    # Create new .env from example
    if [ ! -f .env.example ]; then
        log_error ".env.example not found"
        exit 1
    fi
    
    cp .env.example .env
    log_success ".env file created"
    
    # Prompt for configuration
    read -p "🔢 Signal phone number (with country code, e.g., +491234567890): " signal_number
    read -p "🌐 Bridge service port (default: 3000): " bridge_port
    read -p "📡 Signal API port (default: 8080): " signal_api_port
    
    # Use defaults if empty
    bridge_port=${bridge_port:-3000}
    signal_api_port=${signal_api_port:-8080}
    
    # Update .env file
    sed -i "s/SIGNAL_NUMBER=.*/SIGNAL_NUMBER=${signal_number}/" .env
    sed -i "s/PORT=.*/PORT=${bridge_port}/" .env
    sed -i "s/SIGNAL_API_PORT=.*/SIGNAL_API_PORT=${signal_api_port}/" .env
    sed -i "s|SIGNAL_API_URL=.*|SIGNAL_API_URL=http://localhost:${signal_api_port}|" .env
    sed -i "s|chrome_path=.*|chrome_path=${CHROME_PATH}|" .env
    
    # Update global variables
    BRIDGE_PORT=$bridge_port
    SIGNAL_API_PORT=$signal_api_port
    
    log_success "Environment configured"
    log_info "Chrome path: ${CHROME_PATH}"
}


setup_mappings() {
    log_info "Preparing group mappings..."
    
    if [ -f group-mappings.json ]; then
        log_warning "group-mappings.json already exists, skipping"
        return
    fi
    
    if [ ! -f group-mappings.json.example ]; then
        log_error "group-mappings.json.example not found"
        exit 1
    fi
    
    cp group-mappings.json.example group-mappings.json
    log_success "group-mappings.json created"
    echo
    echo "📝 Configure group mappings after setup:"
    echo "   1. Get group IDs: curl http://localhost:${BRIDGE_PORT}/api/groups/{whatsapp|signal}"
    echo "   2. Edit: nano group-mappings.json"
    echo "   3. Restart: npm start"
}

install_dependencies() {
    log_info "Installing Node.js dependencies..."
    npm install
    log_success "Dependencies installed"
}

start_docker_container() {
    log_info "Starting Signal API container..."
    
    # Remove existing container if present
    if ${USE_SUDO} docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Removing existing container: ${CONTAINER_NAME}"
        ${USE_SUDO} docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true
    fi
    
    # Start container
    log_info "Launching container: ${CONTAINER_NAME}"
    ${USE_SUDO} docker run \
        --name ${CONTAINER_NAME} \
        --rm -d \
        -p ${SIGNAL_API_PORT}:8080 \
        -e MODE=json-rpc \
        -v "$PWD/signal-data":/home/.local/share/signal-cli \
        bbernhard/signal-cli-rest-api:latest
    
    wait_for_signal_api
    log_success "Container running: ${CONTAINER_NAME}"
}

# ============================================================================
# Signal Registration
# ============================================================================

handle_qr_code_linking() {
    local qr_url="http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge"
    
    echo
    echo "QR Code Options:"
    echo "1) Open in browser"
    echo "2) Save as PNG file only"
    echo
    read -p "Choose option (1-2): " qr_choice
    
    case $qr_choice in
        1)
            if curl -s -o ./signal_qr.png "$qr_url"; then
                log_success "QR code saved as: signal_qr.png"
                open_in_browser "$qr_url"
                echo
                echo "📋 Scan the QR code with Signal:"
                echo "   Settings → Linked devices → Link device"
            else
                log_error "Failed to generate QR code"
                return 1
            fi
            ;;
        2)
            if curl -s -o ./signal_qr.png "$qr_url"; then
                log_success "QR code saved as: signal_qr.png"
                echo
                echo "📋 Open signal_qr.png and scan with Signal:"
                echo "   Settings → Linked devices → Link device"
            else
                log_error "Failed to generate QR code"
                return 1
            fi
            ;;
        *)
            log_error "Invalid option"
            return 1
            ;;
    esac
    
    echo
    read -p "Press Enter after scanning the QR code..."
    
    # Verify account linking
    log_info "Verifying account..."
    sleep 2
    for i in {1..10}; do
        local accounts=$(get_signal_accounts)
        if [ "$accounts" != "[]" ] && [ -n "$accounts" ]; then
            log_success "Signal account successfully linked!"
            echo "📱 Accounts: $accounts"
            return 0
        fi
        echo "⏳ Checking... ($i/10)"
        sleep 2
    done
    
    log_warning "Account not detected yet (may still be linking)"
    return 0
}

register_signal() {
    set +e  # Allow errors in this section
    
    log_info "Signal account setup"
    
    # Verify API accessibility
    if ! curl -s "http://localhost:${SIGNAL_API_PORT}/v1/about" > /dev/null; then
        log_error "Signal API is not accessible on port ${SIGNAL_API_PORT}"
        log_info "Check status: ${USE_SUDO} docker ps --filter name=${CONTAINER_NAME}"
        log_info "Check logs: ${USE_SUDO} docker logs ${CONTAINER_NAME}"
        exit 1
    fi
    
    # Get Signal number from .env
    local signal_number=""
    if [ -f .env ] && grep -q "^SIGNAL_NUMBER=" .env; then
        signal_number=$(grep "^SIGNAL_NUMBER=" .env | cut -d'=' -f2)
    else
        log_error "Signal number not found in .env"
        exit 1
    fi
    
    # Check if account already exists
    local existing_accounts=$(get_signal_accounts)
    if [ "$existing_accounts" != "[]" ] && [ -n "$existing_accounts" ]; then
        log_success "Signal account already configured!"
        echo "📱 Accounts: $existing_accounts"
        set -e
        return 0
    fi
    
    # QR Code Linking
    echo
    echo "📱 Signal Account Setup: $signal_number"
    echo "========================================"
    echo
    log_info "QR Code Linking (requires existing Signal account)"
    echo
    
    handle_qr_code_linking
    
    # Final status check
    local final_accounts=$(get_signal_accounts)
    if [ "$final_accounts" != "[]" ] && [ -n "$final_accounts" ]; then
        log_success "✅ Signal accounts available"
    else
        log_warning "⚠️  No Signal accounts detected - manual configuration may be needed"
    fi
    
    set -e
}

# ============================================================================
# Final Instructions
# ============================================================================

show_service_instructions() {
    echo
    log_success "Setup completed! 🎉"
    echo
    echo "📋 Next Steps:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo
    echo "1️⃣  Start the bridge service:"
    echo "   npm start"
    echo
    echo "2️⃣  Scan the WhatsApp QR code when prompted"
    echo
    echo "3️⃣  Get group IDs via API:"
    echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/whatsapp"
    echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/signal"
    echo
    echo "4️⃣  Edit group mappings:"
    echo "   nano group-mappings.json"
    echo
    echo "5️⃣  Restart service:"
    echo "   npm start"
    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo
    echo "🔧 Useful Commands:"
    echo "   • Health:  curl http://localhost:${BRIDGE_PORT}/health"
    echo "   • Status:  curl http://localhost:${BRIDGE_PORT}/api/status"
    echo "   • Stop:    ${USE_SUDO} docker rm -f ${CONTAINER_NAME}"
    echo
    echo "📚 For more info, see README.md"
}

# ============================================================================
# Cleanup & Main
# ============================================================================

cleanup() {
    echo
    log_info "Setup interrupted. Cleaning up..."
    ${USE_SUDO} docker rm -f ${CONTAINER_NAME} 2>/dev/null || true
    exit 1
}

trap cleanup INT

main() {
    echo "Starting WhatsApp-Signal Bridge setup..."
    echo
    
    check_requirements
    setup_env
    setup_mappings
    install_dependencies
    start_docker_container
    register_signal
    show_service_instructions
    
    echo
    log_success "🎉 Setup completed successfully!"
    echo "👉 Start the bridge: npm start"
}

# Run setup
main "$@"