#!/usr/bin/env node
'use strict';
// mrs-toolbox CLI 启动器（dist/cli.js 自执行：main().then(process.exit)）。
// 安装方式：npm i -g <本包>（npm 会生成 mrs-toolbox.cmd / mrs-toolbox 垫片）
//           或直接 node bin/mrs-toolbox.js <子命令>
require('../dist/cli.js');
