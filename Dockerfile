FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /data/images && chown -R node:node /data
ENV HOST=0.0.0.0 \
    PORT=3000 \
    IMAGES_DIR=/data/images
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
