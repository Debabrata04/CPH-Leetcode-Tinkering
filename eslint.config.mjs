import envGlobals from "globals";

export default [
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...envGlobals.commonjs,
                ...envGlobals.node,
                ...envGlobals.mocha,
            },

            ecmaVersion: 2022,
            sourceType: "module",
        },

        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    },
];
