module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>"],
  testMatch: ["**/__tests__/**/*.test.js"],
  testPathIgnorePatterns: ["/__tests__/integration_(?!link_transfer_engine)"],
  setupFiles: ["<rootDir>/jest.setup.js"],
  modulePathIgnorePatterns: ["<rootDir>/node_modules"],
};
