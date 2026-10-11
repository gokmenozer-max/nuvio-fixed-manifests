FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=7000
EXPOSE 7000
CMD ["node", "server.js"]
