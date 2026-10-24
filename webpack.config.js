const path = require('path');
const webpack = require('webpack');

// `npm run build:local-key` builds with DEEPSEEK_API_KEY in the environment and
// produces a *gitignored* script with the key compiled in. The normal public
// build compiles an empty string here, so no key can ever appear in the tracked
// public/index.html.
const allowEmbeddedKey = process.env.IU_ALLOW_EMBEDDED_KEY === '1';
const embeddedDeepSeekKey = allowEmbeddedKey && typeof process.env.DEEPSEEK_API_KEY === 'string'
    ? process.env.DEEPSEEK_API_KEY.trim()
    : '';
const embeddedTypeSafeKey = allowEmbeddedKey && typeof process.env.TYPESAFE_API_KEY === 'string'
    ? process.env.TYPESAFE_API_KEY.trim()
    : '';

module.exports = {
    entry: './src/main.tsx',
    module: {
        rules: [
            {
                test: /\.ts|\.tsx$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.s[ac]ss$/i,
                use: [
                    // Creates `style` nodes from JS strings
                    'style-loader',
                    // Translates CSS into CommonJS
                    'css-loader',
                    // Compiles Sass to CSS
                    'sass-loader',
                ],
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js', '.jsx'],
        alias: {
            react: 'preact/compat',
            'react-dom': 'preact/compat',
        },
    },
    output: {
        filename: 'dist.js',
        path: path.resolve(__dirname, 'dist'),
    },
    plugins: [
        new webpack.DefinePlugin({
            __IU_EMBEDDED_DEEPSEEK_KEY__: JSON.stringify(embeddedDeepSeekKey),
            __IU_EMBEDDED_TYPESAFE_KEY__: JSON.stringify(embeddedTypeSafeKey),
        }),
    ],
    devServer: {
        client: {
            overlay: {
                errors: true,
                warnings: false,
            },
        },
    },
};
