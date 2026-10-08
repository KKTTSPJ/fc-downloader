import { describe, expect, it } from 'vitest'
import { keepPopupInApp } from './popup'

const patreon = 'https://www.patreon.com/login'

describe('keepPopupInApp', () => {
  it('keeps identity-provider sign-in popups in-app', () => {
    expect(
      keepPopupInApp(
        patreon,
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
        'new-window'
      )
    ).toBe(true)
    expect(
      keepPopupInApp(patreon, 'https://appleid.apple.com/auth/authorize?x=1', 'foreground-tab')
    ).toBe(true)
    expect(
      keepPopupInApp(patreon, 'https://www.facebook.com/v19.0/dialog/oauth?x=1', 'foreground-tab')
    ).toBe(true)
    expect(
      keepPopupInApp(patreon, 'https://discord.com/oauth2/authorize?x=1', 'foreground-tab')
    ).toBe(true)
  })

  it('keeps sign-in popups in-app however they were opened', () => {
    expect(keepPopupInApp(patreon, 'https://accounts.google.com/signin', 'foreground-tab')).toBe(
      true
    )
  })

  it('keeps same-site scripted popup windows in-app', () => {
    expect(keepPopupInApp(patreon, 'https://www.patreon.com/auth/x', 'new-window')).toBe(true)
    expect(keepPopupInApp('https://www.fanbox.cc/', 'https://api.fanbox.cc/x', 'new-window')).toBe(
      true
    )
  })

  it('sends same-site target=_blank links to the system browser', () => {
    expect(keepPopupInApp(patreon, 'https://www.patreon.com/c/someone', 'foreground-tab')).toBe(
      false
    )
    expect(keepPopupInApp(patreon, 'https://www.patreon.com/posts/1', 'background-tab')).toBe(false)
  })

  it('sends ordinary external links to the system browser', () => {
    expect(keepPopupInApp(patreon, 'https://x.com/someone', 'foreground-tab')).toBe(false)
    expect(keepPopupInApp(patreon, 'https://www.facebook.com/somepage', 'foreground-tab')).toBe(
      false
    )
    expect(keepPopupInApp(patreon, 'https://discord.com/invite/abc', 'foreground-tab')).toBe(false)
    expect(keepPopupInApp(patreon, 'https://www.youtube.com/watch?v=1', 'foreground-tab')).toBe(
      false
    )
  })

  it('never keeps non-web or malformed URLs', () => {
    expect(keepPopupInApp(patreon, 'mailto:a@example.invalid', 'foreground-tab')).toBe(false)
    expect(keepPopupInApp(patreon, 'not a url', 'foreground-tab')).toBe(false)
  })
})
