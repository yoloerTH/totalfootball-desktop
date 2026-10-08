// Copies the non-TS files the shell loads from disk into dist/.
import { cpSync, mkdirSync } from 'node:fs'
mkdirSync('dist/probe', { recursive: true })
cpSync('src/offline.html', 'dist/offline.html')
cpSync('probe/probe.html', 'dist/probe/probe.html')
cpSync('node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'dist/probe/mediabunny.min.mjs')
