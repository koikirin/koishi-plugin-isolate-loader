import { Context, Dict, isNullable, Schema } from 'koishi'
import { resolve } from 'path'
import { } from '@koishijs/plugin-console'
import { } from '@koishijs/plugin-config'
import { } from '@koishijs/plugin-proxy-agent'

declare module '@koishijs/console' {
  interface Events {
    'isolate/switch': (ident: string, enabled?: boolean) => void
    'isolate/reload': (ident: string, config?: any) => void
  }
}

declare module '@cordisjs/core' {
  interface EffectScope {
    configKey?: string
  }
}

const kRecord = Symbol.for('koishi.loader.record')

function insertKey(object: {}, temp: {}, rest: string[]) {
  for (const key of rest) {
    temp[key] = object[key]
    delete object[key]
  }
  Object.assign(object, temp)
}

function rename(object: any, old: string, neo: string, value: any) {
  const keys = Object.keys(object)
  const index = keys.findIndex(key => key === old || key === '~' + old)
  const rest = index < 0 ? [] : keys.slice(index + 1)
  const temp = { [neo]: value }
  delete object[old]
  delete object['~' + old]
  insertKey(object, temp, rest)
}

export class IsolateLoader {
  static name = 'isolate-loader'

  constructor(public ctx: Context, public config: IsolateLoader.Config) {
    ctx.inject(['console'], (ctx) => {
      ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist'),
      })

      ctx.console.addListener('isolate/switch', async (ident, enabled) => {
        const [parentConfig, groupKey, parentIdent] = this.resolveConfig(ident)
        let groupConfig = parentConfig[groupKey]
        if (isNullable(enabled)) enabled = !groupConfig.$isolateConfig?.enabled
        if (enabled === groupConfig.$isolateConfig?.enabled) return
        ;(groupConfig.$isolateConfig ??= {}).enabled = enabled
        groupConfig = JSON.parse(JSON.stringify(groupConfig))

        if (enabled) {
          if (!groupKey.startsWith('~')) {
            await ctx.console.services.config.unload(parentIdent, groupKey, groupConfig)
          }
          await this.reload(ident)
          await ctx.loader.writeConfig()
        } else {
          this.unload(ident)
          await ctx.console.services.config.reload(parentIdent, groupKey.slice(1), groupConfig)
        }
      })

      ctx.console.addListener('isolate/reload', async (ident, config) => {
        const [parentConfig, groupKey] = this.resolveConfig(ident)
        if (config) {
          parentConfig[groupKey].$isolateConfig = config
          await ctx.loader.writeConfig()
        }
        await this.reload(ident)
      })
    })

    ctx.on('ready', async () => {
      for (const [config, groupKey, parentIdent] of this.resolveIsolateGroups()) {
        await this.load(config, groupKey, parentIdent).catch((e) => ctx.logger.warn(`failed to apply ${groupKey}: %s`, e))
      }
    })

    ctx.on('internal/fork', async (fork) => {
      if (!fork.uid || fork.runtime.name !== 'group') return
      await Promise.resolve()
      if (!fork.key) return
      for (const [config, groupKey, parentIdent] of this.resolveIsolateGroups(fork.config, fork.key)) {
        await this.load(config, groupKey, parentIdent).catch((e) => ctx.logger.warn(`failed to apply ${groupKey}: %s`, e))
      }
    })
  }

  async reload(ident: string) {
    if (this.resolveFork(ident)) this.unload(ident)
    const [parentConfig, groupKey, parentIdent] = this.resolveConfig(ident)
    await this.load(parentConfig, groupKey, parentIdent)
  }

  async load(parentConfig: Dict<IsolateLoader.GroupConfig>, groupKey: string, parentIdent: string) {
    const ident = groupKey.slice(7)
    const parentFork = this.resolveFork(parentIdent)
    if (!parentFork) throw new Error('parent not found')
    if (this.resolveFork(ident)) throw new Error('fork already activated')
    const groupConfig = parentConfig[groupKey]
    this.ctx.logger.info('apply isolated group %c:%c', groupConfig.$label, ident)

    let ctx2 = isNullable(groupConfig.$isolateConfig?.proxyAgent)
      ? parentFork.ctx
      : parentFork.ctx.intercept('http', { proxyAgent: groupConfig.$isolateConfig.proxyAgent })
    Object.entries(groupConfig.$isolateConfig?.isolatedServices ?? {}).forEach(
      ([key, label]) => ctx2 = ctx2.isolate(key, label ? Symbol.for(`isolate.${label}`) : undefined),
    )

    const fork = ctx2.plugin(() => {}, groupConfig)
    fork.key = ident
    fork.configKey = groupKey.slice(1)
    fork[kRecord] = Object.create(null)
    this.ctx.on('dispose', () => this.unload(ident))

    const nested = []
    for (const key in groupConfig) {
      if (key.startsWith('~group:') && groupConfig[key].$isolateConfig?.enabled) {
        nested.push(key.slice(7))
      }
      if (key.startsWith('~') || key.startsWith('$')) continue
      this.ctx.logger.info('apply isolated plugin %c', key, groupConfig[key])
      await this.ctx.loader.reload(fork.ctx, key, groupConfig[key])
    }

    for (const key of nested) {
      await this.reload(key)
    }
  }

  unload(ident: string) {
    const fork = this.resolveFork(ident)
    if (!fork) return
    this.ctx.logger.info('unload isolated group %c:%c', fork.config.$label, ident)

    let { parent, config, configKey } = fork
    configKey ||= Object.keys(parent.scope[kRecord]).find(key => parent.scope[kRecord][key] === fork)
    config = JSON.parse(JSON.stringify(config))
    fork.dispose()
    rename(parent.config, configKey, '~' + configKey, config)
    this.ctx.loader.writeConfig()
  }

  private resolveFork(ident: string) {
    if (!ident) return this.ctx.loader.entry.scope
    for (const main of this.ctx.registry.values()) {
      for (const fork of main.children) {
        if (fork.key === ident) return fork
      }
    }
  }

  private resolveConfig(ident: string, config = this.ctx.loader.config.plugins, parentIdent?: string): [Dict<IsolateLoader.GroupConfig>, string, string] {
    for (const key in config) {
      const [name] = key.split(':', 1)
      if (key.slice(name.length + 1) === ident) return [config, key, parentIdent]
      if (name === 'group' || name === '~group') {
        try {
          return this.resolveConfig(ident, config[key], key.slice(name.length + 1))
        } catch {}
      }
    }
    throw new Error('plugin not found')
  }

  private* resolveIsolateGroups(config = this.ctx.loader.config.plugins, parentIdent?: string): Generator<[Dict<IsolateLoader.GroupConfig>, string, string]> {
    for (const key in config) {
      const [name] = key.split(':', 1)
      if (name === '~group' && config[key].$isolateConfig?.enabled) yield [config, key, parentIdent]
      if (name === 'group') {
        yield* this.resolveIsolateGroups(config[key], key.slice(name.length + 1))
      }
    }
  }
}

export namespace IsolateLoader {
  export const usage = '将需要接管的插件放入独立的分组内，由其中任意插件的配置界面进行操作。所有插件均可正常开启/关闭/重载，分组亦可嵌套。'

  export interface Config {}

  export const Config: Schema<Config> = Schema.object({})

  export interface GroupConfig {
    $isolateConfig?: {
      isolatedServices?: Dict<string>
      proxyAgent?: string
      enabled?: boolean
    }
    $label?: string
  }
}

export default IsolateLoader
