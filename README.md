# 安装配置

#### install dependencies

在项目根目录执行，安装依赖

```
npm i
```

#### build

npm run build

#### docker

```

docker build -t btc-relay -f deployment/Dockerfile .
```

# 服务

#### 运行 btc Relay 服务

```
npm -w packages/btc-relay run start
```

#### 运行中间节点

# 测试

#### 运行跨链测试

```
npm start -w cross-btc-evm
```
