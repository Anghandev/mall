import { Building2, Crosshair, ImagePlus, MapPin, Plus, Printer, ShieldCheck } from 'lucide-react';
import { EmptyState, FieldHelp, PageHeader } from '../components/ui';

export function StoresPage() {
  return (
    <div className="page-stack">
      <PageHeader
        actions={<button className="button primary" disabled type="button"><Plus aria-hidden="true" size={16} /> 新增门店</button>}
        description="维护允许到店自提的实体网点。行政区划和设备绑定均需要二次钱包签名。"
        eyebrow="04 / 网点设置"
        title="门店管理"
      />
      <div className="store-layout">
        <section className="section-block store-list" aria-labelledby="store-list-title">
          <div className="section-heading"><div><p className="eyebrow">Locations</p><h2 id="store-list-title">旗下门店</h2></div><span>数量不可用</span></div>
          <EmptyState blocked description="门店读模型尚未发布，不能把“无数据”解释为没有门店。" title="门店列表不可用" />
        </section>

        <form className="section-block form-section" onSubmit={(event) => event.preventDefault()} aria-labelledby="store-form-title">
          <div className="section-heading"><div><p className="eyebrow">Store details</p><h2 id="store-form-title">门店资料</h2></div><Building2 aria-hidden="true" size={19} /></div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="store-name">门店名称</label><input disabled id="store-name" placeholder="选择门店后显示" type="text" /></div>
            <div className="field"><label htmlFor="store-phone">服务电话</label><input disabled id="store-phone" inputMode="tel" placeholder="选择门店后显示" type="tel" /></div>
          </div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="open-hours">营业时间</label><input disabled id="open-hours" placeholder="例如 09:00 至 21:00" type="text" /></div>
            <div className="field"><label htmlFor="coordinates">精准地图坐标</label><div className="input-action"><input disabled id="coordinates" placeholder="由地图定位" type="text" /><button aria-label="地图定位" className="icon-button" disabled type="button"><Crosshair aria-hidden="true" size={17} /></button></div></div>
          </div>
          <fieldset className="field"><legend>门店实景图</legend><button className="inline-upload" disabled type="button"><ImagePlus aria-hidden="true" size={19} /> 上传门店照片</button></fieldset>

          <div className="immutable-fieldset">
            <div className="immutable-heading"><MapPin aria-hidden="true" size={20} /><div><strong>行政区划绑定</strong><span>保存后永久锁定，迁址必须创建替代门店</span></div></div>
            <div className="two-column-fields">
              <div className="field"><label htmlFor="region-code">6 位行政区划代码</label><input disabled id="region-code" placeholder="由地图服务反向解析" readOnly type="text" /><FieldHelp>禁止手工回填。</FieldHelp></div>
              <div className="field"><label htmlFor="region-proof">签名证明</label><input disabled id="region-proof" placeholder="等待二次钱包签名 intent" readOnly type="text" /></div>
            </div>
          </div>

          <div className="printer-setting">
            <Printer aria-hidden="true" size={20} />
            <div><strong>核销云打印机</strong><span>设备账号与实体双联出单证据尚未配置</span></div>
            <button className="button secondary" disabled type="button">绑定设备</button>
          </div>
          <div className="signature-note"><ShieldCheck aria-hidden="true" size={17} />保存行政区划或更换打印机前，会签署资源、旧值、新值、摘要和有效期。</div>
          <div className="form-actions"><button className="button secondary" disabled type="button">取消</button><button className="button primary" disabled type="submit">保存门店</button></div>
        </form>
      </div>
    </div>
  );
}
