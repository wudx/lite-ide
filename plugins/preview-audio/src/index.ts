import type { Plugin } from '@lite-ide/kernel'
import { isAudioExtension } from '@lite-ide/workbench'
// Bundle-format build: the preview component is statically imported so the
// CJS dist stays a single file (no rollup dynamic-import chunks).
import AudioPreview from './AudioPreview'
import './plugin.css'

export const previewAudioPlugin: Plugin = {
  id: 'builtin.preview-audio',
  name: 'Audio Previewer',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: {
        'previewAudio.label': '声音',
        'previewAudio.regionLabel': '音频预览：{name}',
        'previewAudio.loadError': '无法播放音频文件：{path}（{mime}）',
        'previewAudio.playbackPosition': '播放进度',
        'previewAudio.playbackProgress': '{current} / {total}',
        'previewAudio.play': '播放',
        'previewAudio.pause': '暂停',
        'previewAudio.playShortcut': '播放 (Space)',
        'previewAudio.pauseShortcut': '暂停 (Space)',
        'previewAudio.restart': '重播',
        'previewAudio.toggleLoop': '切换循环',
        'previewAudio.loopTitle': '循环播放',
        'previewAudio.playbackSpeed': '播放倍速',
        'previewAudio.mute': '静音',
        'previewAudio.unmute': '取消静音',
        'previewAudio.volume': '音量',
        'previewAudio.mono': '单声道',
        'previewAudio.stereo': '立体声',
        'previewAudio.channels': '{count} 声道',
      },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: {
        'previewAudio.label': 'Audio',
        'previewAudio.regionLabel': 'Audio preview: {name}',
        'previewAudio.loadError': 'Unable to play audio file: {path} ({mime})',
        'previewAudio.playbackPosition': 'Playback position',
        'previewAudio.playbackProgress': '{current} of {total}',
        'previewAudio.play': 'Play',
        'previewAudio.pause': 'Pause',
        'previewAudio.playShortcut': 'Play (Space)',
        'previewAudio.pauseShortcut': 'Pause (Space)',
        'previewAudio.restart': 'Restart',
        'previewAudio.toggleLoop': 'Toggle loop',
        'previewAudio.loopTitle': 'Loop playback',
        'previewAudio.playbackSpeed': 'Playback speed',
        'previewAudio.mute': 'Mute',
        'previewAudio.unmute': 'Unmute',
        'previewAudio.volume': 'Volume',
        'previewAudio.mono': 'Mono',
        'previewAudio.stereo': 'Stereo',
        'previewAudio.channels': '{count} ch',
      },
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-audio',
      label: 'Audio',
      labelKey: 'previewAudio.label',
      priority: 60,
      canHandle: (file) => isAudioExtension(file.ext),
      load: () => Promise.resolve({ default: AudioPreview }),
    })
  },
}

export default previewAudioPlugin
