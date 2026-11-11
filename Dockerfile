FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# 零依赖，无需 npm install；保留这行注释说明意图
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 8000
ENV PORT=8000
CMD ["node", "server.js"]
