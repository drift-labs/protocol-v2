#!/bin/bash

# Pre-commit hook to check for potential secrets
# This script checks for common patterns that might indicate secrets being committed

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Checking for potential secrets in staged files..."

# Get list of staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
    echo "✅ No files staged for commit"
    exit 0
fi

# Patterns to check for (add more as needed)
PATTERNS=(
    # RPC URLs and endpoints
    "https://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    "wss://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    "ws://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    "http://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    
    # API keys and tokens (common patterns)
    "[a-zA-Z0-9]{32,}"  # Long alphanumeric strings (likely tokens)
    "sk-[a-zA-Z0-9]{20,}"  # Stripe-like keys
    "pk_[a-zA-Z0-9]{20,}"  # Public keys
    "sk_[a-zA-Z0-9]{20,}"  # Secret keys
    
    # Private keys and addresses
    "[1-9A-HJ-NP-Za-km-z]{32,}"  # Base58 encoded strings (likely private keys)
    "0x[a-fA-F0-9]{40}"  # Ethereum addresses
    "[1-9A-HJ-NP-Za-km-z]{44}"  # Solana addresses
    
    # Common secret patterns
    "password.*=.*['\"][^'\"]{8,}['\"]"
    "secret.*=.*['\"][^'\"]{8,}['\"]"
    "token.*=.*['\"][^'\"]{8,}['\"]"
    "key.*=.*['\"][^'\"]{8,}['\"]"
    "api_key.*=.*['\"][^'\"]{8,}['\"]"
    "private_key.*=.*['\"][^'\"]{8,}['\"]"
    
    # Environment variables that might contain secrets
    "ENDPOINT.*=.*['\"][^'\"]{10,}['\"]"
    "WS_ENDPOINT.*=.*['\"][^'\"]{10,}['\"]"
    "GRPC_ENDPOINT.*=.*['\"][^'\"]{10,}['\"]"
    "TOKEN.*=.*['\"][^'\"]{8,}['\"]"
    "API_KEY.*=.*['\"][^'\"]{8,}['\"]"
    "SECRET.*=.*['\"][^'\"]{8,}['\"]"
)

# Files to exclude from checking
EXCLUDE_PATTERNS=(
    "node_modules"
    ".git"
    "*.lock"
    "*.lockb"
    "*.so"
    "*.dll"
    "*.exe"
    "*.bin"
    "*.min.js"
    "*.min.css"
    "*.map"
    "*.log"
    "*.tmp"
    "*.cache"
    "build/"
    "dist/"
    ".env.example"
    "scripts/check-secrets.sh"  # Exclude this script itself
)

# Function to check if file should be excluded
should_exclude() {
    local file="$1"
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        if [[ "$file" == *"$pattern"* ]] || [[ "$file" =~ $pattern ]]; then
            return 0
        fi
    done
    return 1
}

# Function to check for patterns in a file
check_file() {
    local file="$1"
    local found_secrets=false
    
    # Skip binary files
    if file "$file" | grep -q "binary"; then
        return 0
    fi
    
    # Check each pattern
    for pattern in "${PATTERNS[@]}"; do
        if git grep --cached "$pattern" "$file" >/dev/null 2>&1; then
            echo -e "${RED}⚠️  Potential secret found in $file${NC}"
            echo -e "${YELLOW}Pattern: $pattern${NC}"
            git grep --cached "$pattern" "$file" | head -3
            echo ""
            found_secrets=true
        fi
    done
    
    if [ "$found_secrets" = true ]; then
        return 1
    fi
    
    return 0
}

# Check each staged file
has_secrets=false
for file in $STAGED_FILES; do
    if should_exclude "$file"; then
        echo -e "${GREEN}✅ Skipping excluded file: $file${NC}"
        continue
    fi
    
    if ! check_file "$file"; then
        has_secrets=true
    fi
done

if [ "$has_secrets" = true ]; then
    echo -e "${RED}❌ Potential secrets detected!${NC}"
    echo -e "${YELLOW}Please review the above matches and ensure no real secrets are being committed.${NC}"
    echo -e "${YELLOW}If these are false positives, you can:${NC}"
    echo -e "${YELLOW}1. Add the file to .gitignore${NC}"
    echo -e "${YELLOW}2. Use placeholder values instead of real secrets${NC}"
    echo -e "${YELLOW}3. Add the pattern to the exclude list in this script${NC}"
    exit 1
else
    echo -e "${GREEN}✅ No potential secrets detected${NC}"
    exit 0
fi 