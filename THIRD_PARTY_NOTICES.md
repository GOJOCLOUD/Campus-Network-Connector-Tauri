# 第三方组件与依赖的授权记录

> **这份文件是"防授权变更"的凭据,不是可选的礼节。**
>
> 本项目的界面大量使用了 **MIT 协议**的开源 UI 组件(shadcn/ui 体系)。
> 上游作者**将来有可能改协议**。一旦改了,只看"今天的 LICENSE"就无法证明
> "我们当初用的时候它是 MIT"。
>
> 所以这里把 **引入时间 / 确切版本 / 许可证 / 来源** 固定成一份书面记录,
> 配合 git 历史与 `package-lock.json` 的版本锁,构成可核验的证据链。
> 升级任何一项依赖时,**一并更新本文件**(版本、日期、许可证)。
>
> 记录日期:2026-10-22

## 一、界面组件(UI)

这些是**直接复制进仓库源码**的组件(不是运行时依赖),所以它们的许可证
随源码一起分发,授权记录尤其重要。

| 组件 | 引入时的版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| shadcn/ui 组件体系 | 4.3.1 (CLI) | **MIT** | https://github.com/shadcn-ui/ui |
| Radix UI primitives | 1.4.3 / 1.2.3 / 1.1.15 | **MIT** | https://github.com/radix-ui/primitives |
| lucide-react 图标 | 0.577.0 | **ISC** | https://github.com/lucide-icons/lucide |

shadcn/ui 采用"**复制源码到你自己的仓库**"的方式分发:引入的当刻,
这些组件代码在 MIT 协议之下;若上游日后改协议,**本仓库已引入的那份代码
仍受引入时的 MIT 协议约束**(MIT 不要求衍生作品采用同一协议,只要求保留
版权与许可声明)。因此**务必保留这些组件文件原有的版权头**。

> 组件配置见 `components.json`(shadcn 的 registry 配置)。

## 二、运行时依赖(锁定版本)

确切版本以 `package-lock.json` 为准(机器可读、可复现);下表是 2026-10-22
记录时的快照。

| 依赖 | 版本 | 许可证 |
| --- | --- | --- |
| shadcn | 4.3.1 | MIT |
| radix-ui | 1.4.3 | MIT |
| lucide-react | 0.577.0 | ISC |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| tailwind-merge | 3.5.0 | MIT |
| clsx | 2.1.0→2.1.1 | MIT |
| motion | 12.38.0 | MIT |
| tailwindcss | 4.2.3 | MIT |

各依赖的完整许可证原文随包分发在 `node_modules/<包名>/LICENSE`
(安装后即可查),`package-lock.json` 里也记录了每个包的 `license` 字段。

## 三、怎么用这份记录

1. **要证明"引入时是 MIT"** → 本文件(日期+版本)+ `package-lock.json`(版本锁)
   + git 历史(引入那次提交的内容)三者互相印证。
2. **要核对现在是什么协议** → `node_modules/<包名>/LICENSE` 或
   `npm view <包名> license`。
3. **升级依赖** → 改 `package-lock.json` 的同时,更新上面两张表的版本与日期;
   若某个包的许可证**变了**(例如 MIT → BUSL/SSPL 之类),那是需要重新评估
   授权风险的事件,不能默默带过。

## 四、关于本仓库自身

本仓库的对外授权以根目录 `LICENSE` 为准(若尚未添加,说明尚未定稿)。
第三方组件的授权**不因本仓库的授权而改变**,它们各自按上表执行。
