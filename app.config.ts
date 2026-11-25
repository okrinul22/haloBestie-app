const bestie = process.env.EXPO_PUBLIC_APP_ROLE === 'bestie';
export default {
  expo: {
    name: bestie ? 'HaloBestie Listener' : 'HaloBestie Customer',
    slug: bestie ? 'halobestie-listener' : 'halobestie-customer',
    version: '1.0.0',
    orientation: 'portrait',
    scheme: bestie ? 'halobestie-listener' : 'halobestie',
    ios: { bundleIdentifier: bestie ? 'com.halobestie.listener' : 'com.halobestie.customer' },
    android: { package: bestie ? 'com.halobestie.listener' : 'com.halobestie.customer' },
    web: { bundler: 'metro' }
  }
};
