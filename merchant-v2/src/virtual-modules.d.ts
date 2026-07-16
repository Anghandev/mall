declare module 'virtual:merchant-store-operations' {
  const operations: Readonly<{
    list: string;
    create: string;
    update: string;
    activate: string;
    close: string;
  }>;

  export default operations;
}
