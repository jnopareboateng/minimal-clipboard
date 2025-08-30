#!/bin/bash

# Create Release Script for Minimal Clipboard
# Usage: ./scripts/create_release.sh [patch|minor|major]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "Not in a git repository"
    exit 1
fi

# Check if working directory is clean
if [[ -n $(git status --porcelain) ]]; then
    print_error "Working directory is not clean. Please commit or stash your changes."
    exit 1
fi

# Get the release type (patch, minor, major)
RELEASE_TYPE=${1:-patch}

if [[ ! "$RELEASE_TYPE" =~ ^(patch|minor|major)$ ]]; then
    print_error "Invalid release type. Use: patch, minor, or major"
    exit 1
fi

print_status "Creating $RELEASE_TYPE release..."

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
print_status "Current version: $CURRENT_VERSION"

# Update version and get new version
NEW_VERSION=$(npm version $RELEASE_TYPE --no-git-tag-version)
print_status "New version: $NEW_VERSION"

# Create commit with Shakespearean style
COMMIT_MESSAGE="Hark! Version $NEW_VERSION doth arise with great fanfare and noble improvements"
git add package.json package-lock.json
git commit -m "$COMMIT_MESSAGE"

# Create annotated tag
TAG_MESSAGE="Release $NEW_VERSION - A most excellent version with wondrous features and improvements"
git tag -a "$NEW_VERSION" -m "$TAG_MESSAGE"

print_status "Created commit and tag for $NEW_VERSION"
print_warning "To push the release, run:"
echo "  git push origin main"
echo "  git push origin $NEW_VERSION"
print_warning "Or run: git push && git push --tags"

print_status "GitHub Actions will automatically build and create the release when you push the tag."