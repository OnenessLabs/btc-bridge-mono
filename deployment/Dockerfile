FROM amd64/node:18.0-slim
RUN mkdir -p /app
WORKDIR /app
COPY . .
# RUN npm install zeromq
# RUN apt-get update && apt-get install python3 make gcc g++ -y
RUN npm install
# RUN cd packages/btc-relay;npx tsc
RUN npm run build
CMD [ "npm", "-w","packages/btc-relay", "run", "start" ]