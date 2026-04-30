#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const usageDescriptions = {
  NSCameraUsageDescription:
    'Gemma Desktop uses the camera only when you choose to attach a camera capture to a conversation.',
  NSMicrophoneUsageDescription:
    'Gemma Desktop uses the microphone only when you choose speech input or voice features.',
}

function setPlistString(plistPath, key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], {
      stdio: 'ignore',
    })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plistPath], {
      stdio: 'ignore',
    })
  }
}

function stampUsageDescriptions(plistPath) {
  for (const [key, value] of Object.entries(usageDescriptions)) {
    setPlistString(plistPath, key, value)
  }
}

module.exports = async function afterPackMacOSMediaUsage(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const productFilename = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productFilename}.app`)
  const frameworkPath = path.join(appPath, 'Contents', 'Frameworks')
  const helperPlists = [
    path.join(frameworkPath, `${productFilename} Helper.app`, 'Contents', 'Info.plist'),
    path.join(frameworkPath, `${productFilename} Helper (Renderer).app`, 'Contents', 'Info.plist'),
    path.join(frameworkPath, `${productFilename} Helper (Plugin).app`, 'Contents', 'Info.plist'),
    path.join(frameworkPath, `${productFilename} Helper (GPU).app`, 'Contents', 'Info.plist'),
  ]

  for (const plistPath of helperPlists) {
    if (fs.existsSync(plistPath)) {
      stampUsageDescriptions(plistPath)
    }
  }
}
