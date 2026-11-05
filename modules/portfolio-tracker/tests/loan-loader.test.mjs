// Dependency-free loader for the RED control: stub the sibling modules that
// need installed packages, and let the sync-target loader resolve normally.
const mocks = `
export const parseIBKRFlexQuery = () => ({});
export const brokerDeposits = async () => [];
export const matchBrokerDeposits = async () => [];
export const extractEmailContent = () => ({});
export const extractPdfText = async () => '';
export class SheetsClient {}
export const pullFromOneDrive = async () => ({});
export const pushToOneDrive = async () => ({});
export class PpJavaBridge {}
export const pullFlexXml = async () => ({ success: false, skipped: true });
`;

const stubbed = new Set([
    './ibkr_parser.js',
    './broker_deposits.js',
    './email_handler.js',
    './pdf_extractor.js',
    './sheets_client.js',
    './onedrive.js',
    './java_bridge.js',
    './ibkr_flex.js',
]);

export async function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/tools.js') && stubbed.has(specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(mocks)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
