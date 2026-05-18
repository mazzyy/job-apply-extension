#!/bin/bash
set -e

# Build the backend
cd "/Users/soomro/Desktop/Projects/job apply extension /backend"
bash build.sh

# Build the desktop app
cd ../desktop
npm run build
