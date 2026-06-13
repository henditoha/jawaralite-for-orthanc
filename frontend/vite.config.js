import { defineConfig } from 'vite';

export default defineConfig({
  base: './' // Use relative paths for built assets (crucial for subpath hosting in Orthanc)
});
