<template>
  <template v-if="!isInRootGroup">
    <p>
      <el-button type="primary" @click="switchIsolateGroup">
        {{ isInIsolateGroup ? '将本分组还原为常规插件组' : '将本分组转换为Isolated分组' }}
      </el-button>
      <el-button v-if="isInIsolateGroup" type="primary" @click="saveAndReload">保存配置并重载</el-button>
      <k-form v-if="isInIsolateGroup" v-model="config" :schema="schema" :initial="current.parent.config.$isolateConfig" />
    </p>
  </template>
</template>


<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import { Dict, Schema, send } from '@koishijs/client'
import type { } from 'koishi-plugin-isolate-loader'

const current: any = inject('manager.settings.current')

const isInRootGroup = computed(() => {
  return !current.value.parent.path
})
const isInIsolateGroup = computed(() => {
  return current.value.parent.config.$isolateConfig?.enabled && current.value.parent.disabled
})

const config = ref<Config>({ ...current.value.parent.config.$isolateConfig ?? {} })

const switchIsolateGroup = async () => {
  await send('isolate/switch', current.value.parent.path, !isInIsolateGroup.value)
}

const saveAndReload = async () => {
  await send('isolate/reload', current.value.parent.path, config.value)
}

interface Config {
  isolatedServices?: Dict<string>
  proxyAgent?: string
  enabled?: boolean
}

const schema: Schema<Config> = Schema.object({
  isolatedServices: Schema.dict(Schema.string().required(false), Schema.string().description('要隔离的服务')).default({}).role('table').description('服务与隔离域。（值为空或隔离域名称）'),
  proxyAgent: Schema.string().description('代理地址。'),
}).description('隔离设置（作用于分组）')
</script>
