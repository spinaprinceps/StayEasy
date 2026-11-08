FROM node:24-alpine

WORKDIR /app

# Copy only the dependency list first: this layer is cached and npm ci
# is skipped on rebuilds unless package*.json changed.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
