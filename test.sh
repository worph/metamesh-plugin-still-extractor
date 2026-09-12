#!/bin/bash
# =============================================================================
# Still Extractor Plugin Test Runner
#
# Runs integration tests inside a Docker container with FFprobe available.
# Usage:
#   ./test.sh              # Build and run tests
#   ./test.sh --no-cache   # Rebuild without cache
#   ./test.sh --shell      # Start shell in test container for debugging
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="metamesh-plugin-still-extractor-test"
DOCKERFILE="Dockerfile.test"

# Parse arguments
NO_CACHE=""
SHELL_MODE=""

for arg in "$@"; do
    case $arg in
        --no-cache)
            NO_CACHE="--no-cache"
            ;;
        --shell)
            SHELL_MODE=1
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --no-cache   Rebuild Docker image without cache"
            echo "  --shell      Start interactive shell in test container"
            echo "  --help       Show this help message"
            exit 0
            ;;
    esac
done

echo "=============================================="
echo "  Still Extractor Plugin Test Runner"
echo "=============================================="
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed or not in PATH"
    exit 1
fi

# Build the test image
echo "[1/2] Building test image..."
docker build $NO_CACHE -f "$DOCKERFILE" -t "$IMAGE_NAME" .

if [ -n "$SHELL_MODE" ]; then
    echo ""
    echo "[2/2] Starting interactive shell..."
    echo "      Run 'npm test' to execute tests"
    echo ""
    docker run --rm -it \
        -v "$SCRIPT_DIR/test:/app/test:ro" \
        -v "$SCRIPT_DIR/src:/app/src:ro" \
        "$IMAGE_NAME" \
        /bin/bash
else
    echo ""
    echo "[2/2] Running tests..."
    echo ""

    # Run tests and capture exit code
    docker run --rm \
        -e CI=true \
        "$IMAGE_NAME"

    EXIT_CODE=$?

    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        echo "=============================================="
        echo "  All tests passed!"
        echo "=============================================="
    else
        echo "=============================================="
        echo "  Tests failed (exit code: $EXIT_CODE)"
        echo "=============================================="
    fi

    exit $EXIT_CODE
fi
