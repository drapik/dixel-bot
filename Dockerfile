FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server ./server
COPY scripts ./scripts
COPY index.html ./
COPY .env ./.env

EXPOSE 3000

CMD ["node", "server/index.js"]
