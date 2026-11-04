import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/main.css'
import './styles/background.css'
import './styles/probes.css'

createApp(App)
  .use(createPinia())
  .use(router)
  .mount('#app')
