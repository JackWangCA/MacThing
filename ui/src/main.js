import { createApp } from 'vue';
import App from './App.vue';
import { CT } from './state.js';
import './idle.js';
import './smart.js';
createApp(App).mount('#mount');
CT.app = document.getElementById('app');
CT.ready();
