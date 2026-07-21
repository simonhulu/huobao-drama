import { composeIntroForEpisode } from '../src/services/intro-composer.js'

async function main() {
  for (const id of ['black-title-fade', 'dynasty-year-flash', 'vintage-ken-burns']) {
    console.log('rendering', id)
    const url = await composeIntroForEpisode({ episodeId: 175, episodeNumber: 3, templateId: id })
    console.log('=>', url)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
