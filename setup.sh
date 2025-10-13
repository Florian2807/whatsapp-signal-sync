#!/bin/bash

# WhatsApp-Signal-Bridge Setup Script
# This script automates the initial setup of the bridge service

set -e

echo "🚀 WhatsApp-Signal-Bridge Setup"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
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

# Load port configuration from .env file
load_port_config() {
    # Set default values
    BRIDGE_PORT=3000
    SIGNAL_API_PORT=8080
    
    if [ -f .env ]; then
        # Read port from .env if available
        if grep -q "^PORT=" .env; then
            BRIDGE_PORT=$(grep "^PORT=" .env | cut -d'=' -f2)
        fi
        
        # Parse Signal API URL for port
        if grep -q "^SIGNAL_API_URL=" .env; then
            SIGNAL_API_URL=$(grep "^SIGNAL_API_URL=" .env | cut -d'=' -f2-)
            # Extract port from URL (e.g. http://localhost:8080 -> 8080)
            if [[ $SIGNAL_API_URL =~ :([0-9]+) ]]; then
                SIGNAL_API_PORT="${BASH_REMATCH[1]}"
            fi
        fi
    fi
    
    log_info "Using ports: Bridge=$BRIDGE_PORT, Signal API=$SIGNAL_API_PORT"
}

# Show instructions after setup
show_service_instructions() {
    echo
    log_success "Setup completed! 🎉"
    echo
    echo "📋 Next steps:"
    echo "1. Start service: npm start"
    echo "2. Scan the WhatsApp QR code in the terminal"
    echo "3. Edit group-mappings.json with your group IDs:"
    echo
    echo "   📡 Get WhatsApp groups:"
    echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/whatsapp"
    echo
    echo "   📡 Get Signal groups:"
    echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/signal"
    echo
    echo "   📝 Edit mappings file:"
    echo "   nano group-mappings.json"
    echo
    echo "   💡 Example mapping:"
    echo "   {"
    echo "     \"mappings\": ["
    echo "       {"
    echo "         \"whatsapp\": \"123456789@g.us\","
    echo "         \"signal\": \"base64-encoded-signal-group-id\""
    echo "       }"
    echo "     ]"
    echo "   }"
    echo
    echo "4. Restart the service after editing mappings: npm start"
    echo
    echo "🔧 Service Management:"
    echo "   • Stop service:     pkill -f 'node src/index.js' or Ctrl+C in terminal"
    echo "   • Restart service:  npm start"
    echo "   • Check status:     curl http://localhost:${BRIDGE_PORT}/health"
    echo "   • View logs:        npm start (runs in foreground)"
    echo
    echo "📂 Important API endpoints:"
    echo "   • Health check:     http://localhost:${BRIDGE_PORT}/health"
    echo "   • WhatsApp groups:  http://localhost:${BRIDGE_PORT}/api/groups/whatsapp"
    echo "   • Signal groups:    http://localhost:${BRIDGE_PORT}/api/groups/signal"
    echo "   • Service status:   http://localhost:${BRIDGE_PORT}/api/status"
    echo
    echo "📚 For more information, see README.md"
    echo "🔧 Port configuration: Bridge=${BRIDGE_PORT}, Signal API=${SIGNAL_API_PORT}"
}

# Check prerequisites
check_requirements() {
    log_info "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker and try again."
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not installed. Please install Docker Compose and try again."
        exit 1
    fi
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js and try again."
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed. Please install npm and try again."
        exit 1
    fi
    
    log_success "All prerequisites met"
}

# Configure environment variables
setup_env() {
    log_info "Configuring environment variables..."
    
    if [ ! -f .env ]; then
        cp .env.example .env
        log_success ".env file created"
        
        # Ask for Signal number
        read -p "🔢 Please enter your Signal phone number (with country code, e.g. +491234567890): " signal_number
        
        # Update .env file
        sed -i '' "s/SIGNAL_NUMBER=.*/SIGNAL_NUMBER=${signal_number}/" .env
        
        log_success "Signal number configured in .env"
    else
        log_warning ".env file already exists, skipping..."
    fi
}

# Prepare group mappings
setup_mappings() {
    log_info "Preparing group mappings..."
    
    if [ ! -f group-mappings.json ]; then
        cp group-mappings.json.example group-mappings.json
        log_success "group-mappings.json created"
        echo
        echo "📝 How to edit group mappings:"
        echo "1. After service start: Get group IDs via API"
        echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/whatsapp"
        echo "   curl http://localhost:${BRIDGE_PORT}/api/groups/signal" 
        echo "2. Edit group-mappings.json with text editor:"
        echo "   nano group-mappings.json"
        echo "3. Map WhatsApp group IDs (e.g. 123456789@g.us) to Signal groups"
        echo "4. Restart service: npm start"
        echo
        log_warning "Important: Edit group-mappings.json after installation"
    else
        log_warning "group-mappings.json already exists, skipping..."
    fi
}

# Install Node.js dependencies
install_dependencies() {
    log_info "Installing Node.js dependencies..."
    npm install
    log_success "Dependencies installed"
}

# Start Docker services
start_docker_services() {
    log_info "Starting Docker services..."
    docker compose up -d
    log_success "Docker services started"
    
    # Wait until Signal API is ready
    log_info "Waiting for Signal API..."
    while ! curl -s http://localhost:${SIGNAL_API_PORT}/v1/about > /dev/null; do
        echo -n "."
        sleep 2
    done
    echo
    log_success "Signal API is ready"
}

# Register/configure Signal account
register_signal() {
    set +e  # Disable exit on error for this function
    
    log_info "Signal account setup"
    
    # Check if Signal number from .env is available
    if [ -f .env ] && grep -q "SIGNAL_NUMBER=" .env; then
        signal_number=$(grep "SIGNAL_NUMBER=" .env | cut -d'=' -f2)
    else
        log_error "Signal number not found in .env"
        exit 1
    fi
    
    # Check if account already exists
    existing_accounts=$(curl -s "http://localhost:${SIGNAL_API_PORT}/v1/accounts" 2>/dev/null || echo "[]")
    
    if [ "$existing_accounts" != "[]" ] && [ "$existing_accounts" != "" ]; then
        log_success "✅ Signal account already configured!"
        echo "📱 Available accounts: $existing_accounts"
        set -e
        return 0
    fi
    
    log_info "Configuring new Signal account..."
    
    # Account setup menu
    echo
    echo "📱 Signal Account Setup for: $signal_number"
    echo "=========================================="
    echo
    echo "📋 Choose a setup method:"
    echo "1) QR Code Linking (for existing Signal account)" 
    echo "2) SMS Registration (for new Signal account)"
    echo "3) Skip (configure manually later)"
    echo
    
    while true; do
        read -p "Your choice (1-3): " choice
        case $choice in
            1)
                log_info "Generating QR code for account linking..."
                echo
                echo "🔄 Choose QR code display option:"
                echo "1) Open in browser"
                echo "2) Save as PNG file only"
                echo
                
                while true; do
                    read -p "QR code option (1-2): " qr_choice
                    case $qr_choice in
                        1)
                            log_info "Opening QR code in browser..."
                            if curl -s -o ./signal_qr.png "http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge"; then
                                log_success "QR code saved as: signal_qr.png"
                                
                                # Try to open browser
                                if command -v "$BROWSER" &> /dev/null; then
                                    "$BROWSER" "http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge" &>/dev/null &
                                elif command -v xdg-open &> /dev/null; then
                                    xdg-open "http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge" &>/dev/null &
                                elif command -v open &> /dev/null; then
                                    open "http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge" &>/dev/null &
                                else
                                    echo "Please open manually: http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge"
                                fi
                                
                                echo
                                echo "📋 Instructions:"
                                echo "1. Open Signal on your smartphone"
                                echo "2. Go to Settings → Linked devices"
                                echo "3. Tap '+' or 'Link device'"
                                echo "4. Scan the QR code in your browser"
                            else
                                log_error "Error loading QR code"
                            fi
                            break
                            ;;
                        2)
                            log_info "Downloading QR code as PNG..."
                            if curl -s -o ./signal_qr.png "http://localhost:${SIGNAL_API_PORT}/v1/qrcodelink?device_name=whatsapp-bridge"; then
                                log_success "QR code saved as: signal_qr.png"
                                
                                echo
                                echo "📋 Instructions:"
                                echo "1. Open the file signal_qr.png with an image viewer"
                                echo "2. Open Signal on your smartphone"
                                echo "3. Go to Settings → Linked devices"
                                echo "4. Tap '+' or 'Link device'"
                                echo "5. Scan the QR code"
                            else
                                log_error "Error loading QR code"
                            fi
                            break
                            ;;
                        *)
                            echo "❌ Invalid selection. Please choose 1 or 2."
                            ;;
                    esac
                done
                
                echo
                read -p "⏸️  Press Enter when you have scanned the QR code..."
                
                # Check if account is now available
                sleep 2
                for i in {1..10}; do
                    accounts=$(curl -s "http://localhost:${SIGNAL_API_PORT}/v1/accounts" 2>/dev/null || echo "[]")
                    if [ "$accounts" != "[]" ] && [ "$accounts" != "" ]; then
                        log_success "✅ Signal account successfully linked!"
                        echo "📱 Available accounts: $accounts"
                        set -e
                        return 0
                    fi
                    echo "⏳ Checking account status... ($i/10)"
                    sleep 2
                done
                
                log_warning "Account not detected yet. This can be normal - continue."
                break
                ;;
            2)
                log_info "Starting SMS registration..."
                echo "📞 Registering new Signal number: $signal_number"
                echo
                echo "⚠️  SMS registration requires a CAPTCHA token from Signal."
                echo "    Please visit: https://signalcaptchas.org/registration/generate.html"
                echo "    Copy the captcha token and paste it below."
                echo
                read -p "🔑 Please enter the CAPTCHA token: " captcha_token
                
                if [ -z "$captcha_token" ]; then
                    log_error "CAPTCHA token is required for SMS registration"
                    break
                fi
                
                # Registration request
                log_info "Sending registration request..."
                register_response=$(curl -s -X POST "http://localhost:${SIGNAL_API_PORT}/v1/register/${signal_number}" \
                    -H "Content-Type: application/json" \
                    -d "{\"captcha\": \"${captcha_token}\"}" 2>/dev/null || echo "error")
                
                if echo "$register_response" | grep -q "success\|registered\|sent" || [ "$register_response" == "" ]; then
                    log_success "SMS code requested"
                    echo
                    echo "📱 An SMS code has been sent to $signal_number."
                    read -p "🔢 Please enter the 6-digit SMS code: " sms_code
                    
                    if [ -z "$sms_code" ]; then
                        log_error "SMS code is required"
                        break
                    fi
                    
                    # Verification
                    log_info "Verifying SMS code..."
                    verify_response=$(curl -s -X POST "http://localhost:${SIGNAL_API_PORT}/v1/register/${signal_number}/verify/${sms_code}" 2>/dev/null || echo "error")
                    
                    if echo "$verify_response" | grep -q "success\|verified" || [ "$verify_response" == "" ]; then
                        log_success "✅ Signal account successfully registered!"
                        
                        # Check account status
                        sleep 2
                        accounts=$(curl -s "http://localhost:${SIGNAL_API_PORT}/v1/accounts" 2>/dev/null || echo "[]")
                        echo "📱 Available accounts: $accounts"
                        set -e
                        return 0
                    else
                        log_error "SMS verification failed: $verify_response"
                    fi
                else
                    log_error "SMS registration failed: $register_response"
                    echo "💡 Tip: Make sure the CAPTCHA token is valid and try again."
                fi
                break
                ;;
            3)
                log_info "Signal setup skipped"
                log_warning "Please configure Signal manually after installation:"
                log_info "💡 Check manually: curl http://localhost:${SIGNAL_API_PORT}/v1/accounts"
                break
                ;;
            *)
                echo "❌ Invalid selection. Please choose 1, 2 or 3."
                ;;
        esac
        break
    done
    
    # Final account check
    log_info "Bridge service setup completed"
    final_accounts=$(curl -s "http://localhost:${SIGNAL_API_PORT}/v1/accounts" 2>/dev/null || echo "[]")
    if [ "$final_accounts" != "[]" ] && [ "$final_accounts" != "" ]; then
        log_success "✅ Signal accounts available: $final_accounts"
    else
        log_warning "⚠️  No Signal accounts detected. Manual configuration may be required."
    fi
    
    set -e
}

# Cleanup function for interruption
cleanup() {
    echo
    log_info "Setup interrupted. Cleaning up..."
    docker compose down 2>/dev/null || true
    exit 1
}

# Set trap for cleanup on interruption
trap cleanup INT

# Main function
main() {
    echo "Starting WhatsApp-Signal Bridge setup..."
    echo
    
    check_requirements
    setup_env
    load_port_config
    setup_mappings
    install_dependencies
    start_docker_services
    register_signal
    show_service_instructions
    
    echo
    log_success "🎉 Setup completed successfully!"
    echo "👉 Start the bridge service with: npm start"
}

# Run main function
main "$@"