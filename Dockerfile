# 均匀腐蚀速率核算服务镜像
# 锁定 Node.js 20 运行时
FROM node:20-alpine

WORKDIR /app

# 先装依赖以利用层缓存
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝源码与测试
COPY src ./src
COPY test ./test

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# 容器起来后核算接口即刻可用
CMD ["node", "src/index.js"]
