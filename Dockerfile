FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv && /opt/venv/bin/pip install -q edge-tts
WORKDIR /app
COPY . .
ENV TTS_BIN=/opt/venv/bin/edge-tts HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
