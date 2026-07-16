FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y ffmpeg python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]
