module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src/test/frontend'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'src/main/resources/static/multianchor_comment.js',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageThreshold: {
    global: {
      branches: 22,
      functions: 40,
      lines: 40,
      statements: 38,
    },
  },
  clearMocks: true,
  restoreMocks: true,
};
