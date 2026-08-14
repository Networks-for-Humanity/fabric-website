FROM node:18-alpine

WORKDIR /app
COPY server/*.js ./server/

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV SERVE_STATIC=0
EXPOSE 8787

CMD ["node", "server/index.js"]
