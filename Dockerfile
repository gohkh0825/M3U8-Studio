# Use Node.js LTS as base image
FROM node:20-slim

# Install FFmpeg and VAAPI drivers for hardware acceleration
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libva-drm2 \
    libva2 \
    i965-va-driver \
    intel-media-va-driver-non-free \
    mesa-va-drivers \
    va-driver-all \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Build the frontend
RUN npm run build

# Expose port 3000
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start the server
CMD ["npm", "start"]
