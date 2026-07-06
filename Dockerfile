FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Force rebuild: 2026-07-06
CMD ["node", "server.js"]
