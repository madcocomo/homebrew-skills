---
name: migrate-ah
description: |
  将功能从 AH 遗留系统迁移到新架构（acorn + avia-base + ProdTool）。
  后端迁移：将 API 从 knowledge-base-j 迁移到 avia-base。
  前端迁移：将页面/组件从 AHCustoTool 迁移到 ProdTool。
  使用场景：当需要迁移遗留功能（如版本管理、文件操作、文档浏览）到新系统时。
  自动识别迁移任务：用户提到"迁移"、"从旧系统"、"knowledge-base-j"、"AHCustoTool"等关键词。
---

# AH 系统迁移工作流（Legacy → 新架构）

基于 ICDRE（迭代式上下文驱动需求工程）方法论，将功能从遗留系统迁移到新架构。

## 迁移类型

### 后端 API 迁移
- **源**：`knowledge-base-j` (Spring Boot + JCR)
- **目标**：`avia-base` (Spring Boot + Oak) + `acorn` (核心库)

### 前端页面迁移
- **源**：`AHCustoTool` (Vue 3 Options API + CoreUI v5 + Vuex)
- **目标**：`ProdTool` (Vue 3 Composition API + CoreUI v5 + Pinia)

---

## 迁移流程：ICDRE 四阶段闭环

### 阶段 I：上下文差异提取

**输入**：用户提供要迁移的功能描述或关键字（如"版本管理"、"文件夹浏览"）。

**AI 行为**：

1. **后端**：搜索 `knowledge-base-j/` 中的相关代码
   ```
   knowledge-base-j/webapp/src/main/java/**/*Controller.java
   knowledge-base-j/webapp/src/main/java/**/*Service.java
   knowledge-base-j/webapp/src/test/resources/**/*.feature
   ```

2. **前端**：搜索 `AHCustoTool/` 中的相关页面和组件
   ```
   AHCustoTool/src/views/          # 页面视图
   AHCustoTool/src/components/     # 组件
   AHCustoTool/src/api/            # API 调用
   AHCustoTool/src/store/          # Vuex 模块
   AHCustoTool/src/router/         # 路由配置
   ```

3. 分析遗留实现，识别隐含假设（事务、权限、状态、交互模式等）

4. 向用户提问确认这些假设在新场景下是否成立

**输出**：`docs/wip/migration-{feature}/delta-matrix.md`

**HITL**：用户回答确认差异分析。

### 阶段 II：规则实例化

**输入**：delta-matrix.md + 用户迁移目标

**AI 行为**：
1. 将差异转化为具体的约束规则
2. 生成负向约束（"严禁做 Y，必须做 Z"）
3. 针对前端：记录 UI 组件映射（CoreUI → CoreUI）、状态管理转换（Vuex → Pinia）

**输出**：`docs/wip/migration-{feature}/migration-rules.md`

**HITL**：用户 review 生成的规则。

### 阶段 III：语义契约验证

**输入**：migration-rules.md + 功能描述

**AI 行为**：

1. **后端**：生成 BDD Gherkin feature 文件
   - 位置：`avia-base/application/src/test/resources/features/{feature}.feature`

2. **前端**：定义端到端测试场景或用户交互流程

**输出**：确认的测试文件

**HITL**：审查测试覆盖度。

### 阶段 IV：代码实现

**输入**：确认的测试文件 + migration-rules.md

**AI 行为**：

1. **后端**：实现 Controller → Service → Repository 三层代码
2. **前端**：实现 Vue 3 组件 + Pinia Store + API 服务层

**HITL**：
- 测试失败：诊断是 Spec 问题还是代码问题

**输出**：提交的代码 + 更新后的迁移文档

---

## 后端 API 迁移

### 项目结构

```
AH/
├── acorn/                              # Foundation Layer (Oak仓库)
├── avia-base/                          # Application Layer
│   └── application/                    # REST API + Tests
│       └── src/test/resources/features/# BDD Feature 文件
├── docs/                               # 文档中心
│   ├── req/                           # 需求文档
│   ├── modules/                       # 模块设计
│   └── wip/                           # 迁移中间文档
└── knowledge-base-j/                   # 遗留系统 (参考用)
```

### ATA2300 数据模型

新架构采用基于文件夹层次结构和原型驱动属性继承：

- **直接属性存储**：属性直接存储在节点上，无 `attributeMap` 子节点
- **预计算属性继承**：子节点从父原型继承属性
- **移除 manual/profile archetype**：改用语言等具体属性

### 常用命令

```bash
# 1. 构建 Acorn（修改后必须）
cd acorn && mvn clean install

# 2. 构建 Avia Base
cd avia-base && mvn clean compile

# 3. 运行测试
cd avia-base && mvn test

# 4. 运行特定场景
mvn test -Dcucumber.filter.name=".*场景名.*"
```

---

## 前端页面迁移

### 项目结构

```
AH/
├── ProdTool/                           # Vue 3 前端 (新)
│   ├── src/
│   │   ├── views/                     # 页面组件
│   │   ├── components/                # 公共组件
│   │   ├── layouts/                   # 布局组件
│   │   ├── stores/                    # Pinia 状态管理
│   │   ├── api/                       # API 服务层
│   │   ├── locales/                   # 国际化
│   │   └── router/                    # 路由配置
│   └── AGENTS.md                      # 前端开发指南
└── AHCustoTool/                        # Vue 3 前端 (遗留)
```

### 技术栈迁移对照

| 遗留 | 新系统 | 说明 |
|------|--------|------|
| Options API | Composition API + `<script setup>` | 更简洁的组件写法 |
| CoreUI v5 | CoreUI v5 | UI 组件库（保持一致，便于迁移） |
| Vuex | Pinia | 状态管理（更轻量） |
| Vue Router 4 (hash) | Vue Router 4 (history) | 路由模式 |
| vue-i18n v9 | vue-i18n v9 | 国际化（保持兼容） |
| axios | axios | HTTP 客户端（保持） |

### 迁移模式

#### 1. API 服务层
```typescript
// 遗留 (AHCustoTool/src/api/ccms.js)
import axios from '@/utils/http';
export const folderApi = {
  getFolder: (path) => axios.get(`/api/folder${path}`),
  createFolder: (path, data) => axios.post(`/api/folder${path}`, data),
};

// 新系统 (ProdTool/src/api/folder.api.ts)
import axios from 'axios';
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';

export const getFolder = (path: string, options?: FolderQueryOptions): Promise<Folder> => {
  const params = new URLSearchParams();
  if (options?.childDirs) params.append('childDirs', 'true');
  return axios.get(`${API_BASE}/api/folders${path}`, { params }).then(res => res.data);
};
```

#### 2. 状态管理
```typescript
// 遗留 (AHCustoTool/src/store/modules/folder.js)
export default {
  namespaced: true,
  state: () => ({ currentFolder: null }),
  mutations: { SET_FOLDER(state, folder) { state.currentFolder = folder; } },
  actions: {
    fetchFolder({ commit }, path) {
      return folderApi.getFolder(path).then(res => commit('SET_FOLDER', res.data));
    },
  },
};

// 新系统 (ProdTool/src/stores/folder.ts)
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getFolder } from '@/api/folder.api';

export const useFolderStore = defineStore('folder', () => {
  const currentFolder = ref(null);
  async function loadFolder(path: string) {
    currentFolder.value = await getFolder(path);
  }
  return { currentFolder, loadFolder };
});
```

#### 3. 组件转换
```vue
<!-- 遗留 (Options API + CoreUI) -->
<template>
  <CButton @click="handleClick">Delete</CButton>
  <CTable :items="items" :columns="columns"/>
</template>
<script>
export default {
  methods: {
    handleClick() { /* ... */ }
  }
}
</script>

<!-- 新系统 (Composition API + CoreUI) -->
<template>
  <CButton color="danger" @click="handleClick">Delete</CButton>
  <CTable hover responsive>
    <CTableHead>
      <CTableRow>
        <CTableHeaderCell v-for="col in columns" :key="col">{{ col }}</CTableHeaderCell>
      </CTableRow>
    </CTableHead>
    <CTableBody>
      <CTableRow v-for="item in items" :key="item.id">
        <CTableDataCell>{{ item.name }}</CTableDataCell>
      </CTableRow>
    </CTableBody>
  </CTable>
</template>
<script setup>
function handleClick() { /* ... */ }
</script>
```

### 常用命令

```bash
# 安装依赖
cd ProdTool && npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 代码检查
npm run lint
```

---

## 迁移检查项

### 后端
- [ ] 遵循三层架构（Controller → Service → Repository）
- [ ] Controller 使用 `@RequiredArgsConstructor` 注入依赖
- [ ] 属性直接存储在节点上（无 attributeMap 子节点）
- [ ] 端点路径已更新（如 `/api/tree` → `/api/folders`）
- [ ] BDD 测试覆盖主要场景

### 前端
- [ ] 使用 `<script setup>` 语法
- [ ] 使用 CoreUI Vue 组件
- [ ] 使用 Pinia Store 替代 Vuex
- [ ] 使用 `@/` 别名导入（配置在 tsconfig.json）
- [ ] API 服务层使用 avia-base 端点
- [ ] 图标从 `@coreui/icons` 导入
- [ ] 类型定义使用 TypeScript

---

## 关键文档路径

### 遗留代码搜索

**后端**：
```
knowledge-base-j/webapp/src/main/java/**/*Controller.java
knowledge-base-j/webapp/src/main/java/**/*Service.java
```

**前端**：
```
AHCustoTool/src/views/
AHCustoTool/src/components/
AHCustoTool/src/api/
AHCustoTool/src/store/
```

### 遗留前端设计文档

```
docs/legacy/frontend/
├── README.md
├── Architecture.md
├── views/Views-Module.md
├── components/Components-Module.md
├── api/API-Integration.md
├── store/State-Management.md
└── routing/Routing-Configuration.md
```

### 迁移中间文档

```
docs/wip/migration-{功能名}/
├── delta-matrix.md         # 差异矩阵
├── migration-rules.md      # 迁移规则
└── {功能名}.feature       # BDD feature (后端)
```

### 迁移完成后的文档位置

```
docs/req/
├── legacy-mapping.md       # 遗留系统映射对照
└── {功能名}-migration.md   # 迁移总结
```
