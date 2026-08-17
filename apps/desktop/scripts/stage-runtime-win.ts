/** Stage the Desktop Host for the Windows x64 installer on every host shell. */

process.env.DSH_DESKTOP_TARGET_PLATFORM = 'win32'
process.env.DSH_DESKTOP_TARGET_ARCH = 'x64'

await import('./stage-runtime.ts')
