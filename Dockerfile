# Use Node.js image
FROM node:18-slim

# Install FFmpeg (Ye line sabse zaruri hai)
RUN apt-get update && apt-get install -y ffmpeg

# Create app directory
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all files
COPY . .

# Expose port
EXPOSE 3000

# Start command
CMD [ "node", "server.js" ]
