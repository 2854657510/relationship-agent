import type { Contact } from "../api.ts";

interface ContactListProps {
  contacts: Contact[];
  activeId: string | null;
  onSelect: (contact: Contact) => void;
}

export function ContactList({ contacts, activeId, onSelect }: ContactListProps) {
  return (
    <section className="panel contacts">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Contacts</p>
          <h3>联系人</h3>
        </div>
        <span className="badge">{contacts.length}</span>
      </div>
      <div className="contact-list">
        {contacts.map((contact) => (
          <button
            type="button"
            key={contact.id}
            className={`contact ${contact.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(contact)}
          >
            <span>{contact.display_name}</span>
            <small>v{contact.version}</small>
          </button>
        ))}
        {contacts.length === 0 && <p className="muted">还没有联系人。</p>}
      </div>
    </section>
  );
}
