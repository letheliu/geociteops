# Pull Request

## 变更内容

<!-- 一两句话说清改了什么、为什么。关联 issue：Closes #123 -->

## 测试证据

<!--
本仓库要求「新代码必须带测试」。合并前请勾选并附上实际输出，不要只勾不贴。
-->

- [ ] 新增/修改的逻辑都有对应测试
- [ ] `pnpm test` 本地跑过，结果：**___ 通过 / ___ 失败**
      （失败项若为已知环境性问题——无本地 Postgres、zvec Windows 文件锁——请注明）
- [ ] `pnpm exec tsc --noEmit` 通过（后端）
- [ ] `pnpm --filter geo-web exec vue-tsc -b` 通过（前端）
- [ ] `pnpm exec prisma generate` 已执行（**tsc 前必须**，否则 Prisma 类型全红）

```
粘贴 pnpm test 结尾的 Test Files / Tests 两行：
```

```
粘贴实际命令输出，或说明为何无法运行：
```

## 影响面

- [ ] 仅改动业务代码，不涉及 Prisma schema / 迁移
- [ ] 不涉及部署形态（compose 四服务、Dockerfile）
- [ ] 不涉及 CI 工作流
- [ ] 如涉及上述任一项，已在下方补充说明

## 破坏性变更

- [ ] 无
- [ ] 有（说明如下，并同步更新 CHANGELOG.md 的 Unreleased 段）

```
接口 / 环境变量 / 数据格式的变更说明：
```
